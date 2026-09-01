import { facetsSatisfy, getIntent, INTENT_REGISTRY, SUPPORTED_INTENTS } from '../telegraph/intents.js';
import type { CaseFacets, DecisionCase } from '../types/case.js';
import type { EvidenceItem } from '../types/evidence.js';
import type { IntentName } from '../types/telegraph.js';
import { scoreRelevance } from './confidence-engine.js';
import type { DecisionPolicy } from './policy-engine.js';

/**
 * Adaptive evidence acquisition.
 *
 * Deycid does not run a fixed list of intents. Each round it looks at what it
 * already knows, what it still cannot resolve, and what each unbought intent
 * would plausibly contribute per dollar — then buys only the top candidates
 * that fit the remaining budget.
 *
 * ── Information value (an MVP heuristic, not information theory) ─────────────
 * For each candidate intent:
 *
 *   relevance   from the intent registry, adjusted for the facts this case has
 *   reliability the intent's Telegraph scoring tier (A deterministic > B judge)
 *   novelty     1.0 unbought, then 0.35^k after k previous buys of that intent
 *   conflictBoost  +0.35 when existing evidence is in material conflict and
 *                  this intent is deterministic — a Tier A answer is the
 *                  cheapest way to break a tie
 *   gapBoost    +0.25 when the case has no directional evidence at all yet
 *
 *   expectedInformationValue = relevance x reliability x novelty x (1 + boosts)
 *   score                    = expectedInformationValue / estimatedCost
 *
 * Ranking by value-per-dollar is what makes the intelligence budget meaningful:
 * a cheap deterministic check outranks an expensive open-ended one when both
 * would move the decision by the same amount.
 */

export interface CandidateEvaluation {
  intent: IntentName;
  relevance: number;
  expectedReliability: number;
  novelty: number;
  expectedInformationValue: number;
  estimatedCostUsdc: number;
  /** expectedInformationValue / estimatedCostUsdc. */
  score: number;
  query: string;
  context?: Record<string, unknown>;
  reason: string;
}

const TIER_RELIABILITY = { A_DETERMINISTIC: 0.92, B_LLM_JUDGE: 0.74 } as const;
const NOVELTY_DECAY = 0.35;
const CONFLICT_BOOST = 0.35;
const GAP_BOOST = 0.25;

/** Token symbols Deycid will recognise in free text. Documented, not inferred. */
const KNOWN_ASSETS = [
  'BTC', 'WBTC', 'ETH', 'WETH', 'USDC', 'USDT', 'DAI', 'SOL', 'MATIC', 'ARB',
  'OP', 'BASE', 'LINK', 'UNI', 'AAVE', 'CRV', 'LDO', 'MKR', 'SNX', 'COMP',
  'PEPE', 'DEGEN', 'CBETH', 'RETH', 'STETH', 'FRAX', 'GHO', 'TG',
];

/** Protocol names worth researching when they appear in the decision text. */
const KNOWN_SUBJECTS = [
  'aave', 'uniswap', 'compound', 'curve', 'lido', 'maker', 'makerdao', 'balancer',
  'sushiswap', 'pancakeswap', 'aerodrome', 'velodrome', 'morpho', 'pendle',
  'eigenlayer', 'gmx', 'synthetix', 'yearn', 'convex', 'frax', 'rocket pool',
  'seamless', 'moonwell', 'extra finance', 'baseswap',
];

const TX_HASH = /\b0x[0-9a-fA-F]{64}\b/g;
const EVM_ADDRESS = /\b0x[0-9a-fA-F]{40}\b/g;
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>)]+/gi;

/**
 * Pulls the structured facts out of the caller's decision text and fields.
 *
 * Explicit fields win over anything scraped from prose. Extraction is
 * deliberately conservative — a fact Deycid is unsure of is better dropped than
 * used to justify buying an intent that cannot answer anything.
 */
export function extractFacets(input: {
  decision: string;
  context?: string;
  chain?: string;
  transactionHash?: string;
  actingAddress?: string;
}): CaseFacets {
  const haystack = `${input.decision}\n${input.context ?? ''}`;

  const txMatches = haystack.match(TX_HASH) ?? [];
  const transactionHash = input.transactionHash ?? txMatches[0];

  // A 64-hex run also contains 40-hex runs; strip anything that is part of a
  // transaction hash before treating the rest as addresses.
  const withoutTxHashes = haystack.replace(TX_HASH, ' ');
  const found = Array.from(new Set(withoutTxHashes.match(EVM_ADDRESS) ?? []));

  // The acting wallet is only ever taken from the explicit field. Guessing it
  // out of prose is not reliable, and guessing wrong means asking whether the
  // wrong wallet can afford the action.
  const actingAddress = input.actingAddress;

  // Counterparties are everything that is not the acting wallet.
  const addresses = actingAddress
    ? found.filter((a) => a.toLowerCase() !== actingAddress.toLowerCase())
    : found;

  const urls = Array.from(new Set(haystack.match(URL_PATTERN) ?? []));

  const upper = haystack.toUpperCase();
  const assets = KNOWN_ASSETS.filter((sym) => new RegExp(`\\b${sym}\\b`).test(upper));

  const lower = haystack.toLowerCase();
  const subjects = KNOWN_SUBJECTS.filter((name) => lower.includes(name));

  return {
    ...(input.chain ? { chain: input.chain } : {}),
    ...(transactionHash ? { transactionHash } : {}),
    ...(actingAddress ? { actingAddress } : {}),
    addresses,
    assets,
    urls,
    subjects,
  };
}

/** How many times an intent has already been bought for this case. */
function timesBought(evidence: readonly EvidenceItem[], intent: IntentName): number {
  return evidence.filter((e) => e.requestedIntent === intent).length;
}

/**
 * Scores every registry intent this case could usefully buy next.
 * Intents whose required facts the case lacks, or whose query builder declines,
 * are dropped rather than sent as an unanswerable question.
 */
export function evaluateCandidates(decisionCase: DecisionCase): CandidateEvaluation[] {
  const { facets, evidence, request } = decisionCase;

  const hasDirectional = evidence.some(
    (e) => e.status === 'COLLECTED' && (e.stance === 'SUPPORTS' || e.stance === 'CONTRADICTS'),
  );
  const inConflict = decisionCase.assessment?.materialConflict === true;

  const out: CandidateEvaluation[] = [];

  for (const name of SUPPORTED_INTENTS) {
    const def = INTENT_REGISTRY[name];
    if (!def) continue;
    if (!facetsSatisfy(def, facets)) continue;

    const query = def.buildQuery(facets, request.decision);
    if (!query) continue;

    const relevance = scoreRelevance(name, facets);
    if (relevance <= 0) continue;

    const bought = timesBought(evidence, name);
    const novelty = Math.pow(NOVELTY_DECAY, bought);

    const expectedReliability = TIER_RELIABILITY[def.tier];

    let boost = 0;
    const reasons: string[] = [];
    if (inConflict && def.tier === 'A_DETERMINISTIC') {
      boost += CONFLICT_BOOST;
      reasons.push('deterministic tie-breaker for a material conflict');
    }
    if (!hasDirectional) {
      boost += GAP_BOOST;
      reasons.push('case has no directional evidence yet');
    }
    if (bought > 0) reasons.push(`already bought ${bought}x, novelty x${novelty.toFixed(2)}`);

    const expectedInformationValue = relevance * expectedReliability * novelty * (1 + boost);
    const estimatedCostUsdc = def.estimatedCostUsdc;
    const score = estimatedCostUsdc > 0 ? expectedInformationValue / estimatedCostUsdc : 0;

    const ctx = def.buildContext?.(facets);

    out.push({
      intent: name,
      relevance,
      expectedReliability,
      novelty,
      expectedInformationValue,
      estimatedCostUsdc,
      score,
      query,
      ...(ctx && Object.keys(ctx).length > 0 ? { context: ctx } : {}),
      reason: reasons.length > 0 ? reasons.join('; ') : def.contributes,
    });
  }

  return out.sort((a, b) => b.score - a.score);
}

export interface RoundPlan {
  selected: CandidateEvaluation[];
  /** Candidates rejected for cost, with why. */
  skipped: { intent: IntentName; reason: string }[];
  estimatedCostUsdc: number;
}

/**
 * Plans the next round: the highest value-per-dollar candidates that still fit
 * the remaining budget.
 *
 * The budget check is a hard precondition, not advice — a candidate whose
 * estimated cost exceeds what is left is never selected. The x402 layer applies
 * its own independent per-call ceiling underneath this.
 */
export function planRound(decisionCase: DecisionCase, policy: DecisionPolicy): RoundPlan {
  const candidates = evaluateCandidates(decisionCase);
  const selected: CandidateEvaluation[] = [];
  const skipped: { intent: IntentName; reason: string }[] = [];

  let budgetLeft = decisionCase.budget.remainingUsdc;
  let estimated = 0;

  for (const candidate of candidates) {
    if (selected.length >= policy.intentsPerRound) break;

    if (candidate.estimatedCostUsdc > budgetLeft) {
      skipped.push({
        intent: candidate.intent,
        reason: `estimated $${candidate.estimatedCostUsdc.toFixed(3)} exceeds remaining $${budgetLeft.toFixed(3)}`,
      });
      continue;
    }
    selected.push(candidate);
    budgetLeft -= candidate.estimatedCostUsdc;
    estimated += candidate.estimatedCostUsdc;
  }

  return { selected, skipped, estimatedCostUsdc: estimated };
}

/**
 * Whether another round is worth opening.
 *
 * Stops on any of: target reached with enough corroboration, budget spent,
 * rounds exhausted, or nothing affordable left to buy. A material conflict
 * forces continuation even when confidence looks adequate — disagreement is
 * exactly the situation where one more deterministic answer is worth its price.
 */
export function shouldContinueResearch(
  decisionCase: DecisionCase,
  policy: DecisionPolicy,
): { proceed: boolean; reason: string } {
  const { assessment, request, budget, roundsUsed } = decisionCase;

  if (roundsUsed >= request.maxRounds) {
    return { proceed: false, reason: `Round limit reached (${request.maxRounds}).` };
  }

  const cheapest = Math.min(
    ...SUPPORTED_INTENTS.map((n) => getIntent(n)?.estimatedCostUsdc ?? Infinity),
  );
  if (budget.remainingUsdc < cheapest) {
    return {
      proceed: false,
      reason: `Remaining budget $${budget.remainingUsdc.toFixed(4)} is below the cheapest intent ($${cheapest.toFixed(3)}).`,
    };
  }

  if (!assessment || assessment.direction === 'NONE') {
    return { proceed: true, reason: 'No directional evidence yet.' };
  }

  if (assessment.materialConflict) {
    return {
      proceed: true,
      reason: `Material conflict (contradiction ratio ${assessment.contradictionRatio.toFixed(3)} > ${policy.maxContradictionRatio}).`,
    };
  }

  if (assessment.confidence >= request.confidenceThreshold) {
    if (assessment.distinctIntents < policy.minDistinctIntents) {
      return {
        proceed: true,
        reason:
          `Confidence target met but only ${assessment.distinctIntents} distinct intent(s) corroborate; ` +
          `policy requires ${policy.minDistinctIntents}.`,
      };
    }
    return { proceed: false, reason: 'Confidence target reached with sufficient corroboration.' };
  }

  const plan = planRound(decisionCase, policy);
  if (plan.selected.length === 0) {
    return { proceed: false, reason: 'No affordable intelligence left that would add anything new.' };
  }

  return {
    proceed: true,
    reason: `Confidence ${assessment.confidence.toFixed(3)} is below target ${request.confidenceThreshold}.`,
  };
}

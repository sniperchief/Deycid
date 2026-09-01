import { ConfidenceEvaluationError } from '../errors.js';
import { getIntent } from '../telegraph/intents.js';
import type { CaseFacets } from '../types/case.js';
import type {
  ConfidenceAssessment,
  EvidenceItem,
  EvidenceQuality,
  EvidenceStance,
} from '../types/evidence.js';
import type { TelegraphAskRecord } from '../types/telegraph.js';
import type { DecisionPolicy } from './policy-engine.js';

/**
 * The confidence engine.
 *
 * Deterministic and auditable by construction: the same evidence always yields
 * the same number, and every number it produces comes with a written trace. No
 * LLM is asked "how confident are you?" — the whole point of Deycid is that the
 * answer is derived from properties of the evidence that can be inspected.
 *
 * ── Whose confidence is this? ────────────────────────────────────────────────
 * Telegraph does not return a per-response confidence score on
 * `POST /engine/v1/ask`. Everything computed here is therefore **Deycid
 * confidence**, derived from observable properties of the Telegraph exchange,
 * and it is labelled that way everywhere it surfaces. Telegraph's own quality
 * machinery (validator scoring, leaderboards, probabilistic routing) is what
 * makes the underlying answers trustworthy; Deycid does not restate it as a
 * number it did not receive.
 *
 * ── Per-item weight ──────────────────────────────────────────────────────────
 *   weight = reliability x relevance x freshness
 *
 * reliability starts from the intent's Telegraph scoring tier — Tier A
 * (deterministic, WASM exact-match against scraped ground truth) is trusted
 * above Tier B (LLM-judge) — and is then adjusted by four observable facts:
 *   - did Telegraph route the query to the intent Deycid aimed at?
 *   - did the call get recorded under a signal hash?
 *   - did Telegraph attach warnings?
 *   - how cleanly could the normalizer read the answer (HIGH/MEDIUM/LOW)?
 *
 * relevance comes from the intent registry's base relevance, lifted when the
 * intent addresses a fact the case actually carries.
 *
 * freshness is exponential decay on the intent's half-life, so a stale price
 * counts for less than a freshly mined transaction.
 *
 * ── Aggregation ──────────────────────────────────────────────────────────────
 * Support mass S and contradiction mass C are the summed weights of SUPPORTS
 * and CONTRADICTS items. NEUTRAL and UNCERTAIN items carry no direction and are
 * excluded from both — they can never manufacture confidence.
 *
 *   evidenceStrength  E = 1 - exp(-(S + C) / MASS_SCALE)     saturating in volume
 *   agreement         A = max(S, C) / (S + C)                0.5 (split) .. 1
 *   corroboration     R = 1 - exp(-DISTINCT_RATE x n)        n distinct intents
 *   contradictionRatio p = min(S, C) / (S + C)               0 .. 0.5
 *
 *   confidence = E x A x R x (1 - p x policy.contradictionPenaltyWeight)
 *
 * Averaging confidences is deliberately avoided: two agreeing sources should
 * beat one, and a contradiction should cost more than it gains. The product
 * form gives both, and every factor is bounded on [0,1] so the result is too.
 */

/** Directional mass at which evidenceStrength reaches ~63%. */
const MASS_SCALE = 1.15;
/** Corroboration rate: 1 intent ~0.57, 2 ~0.81, 3 ~0.92. */
const DISTINCT_RATE = 0.85;
/** Nothing is ever certain; caps the aggregate. */
const CONFIDENCE_CEILING = 0.99;

/** Base reliability by Telegraph scoring tier. */
const TIER_RELIABILITY = {
  A_DETERMINISTIC: 0.92,
  B_LLM_JUDGE: 0.74,
} as const;

/** How cleanly the normalizer read the answer. */
const QUALITY_FACTOR: Record<EvidenceQuality, number> = {
  HIGH: 1.0,
  MEDIUM: 0.88,
  LOW: 0.7,
};

/** Applied when Telegraph routed the query somewhere other than Deycid aimed. */
const ROUTING_MISMATCH_FACTOR = 0.82;
/** Applied when Telegraph reported no signal hash for the call. */
const NO_SIGNAL_HASH_FACTOR = 0.9;
/**
 * Per Telegraph warning, capped at two.
 *
 * Kept deliberately small. Telegraph documents warnings as advisory — "The
 * request still ran" — and a live run bore that out: a `parameter "protocol"
 * length 0` warning accompanied a miner answer that was entirely correct
 * ($17.9bn TVL for Aave), because the miner parses the natural-language
 * question rather than the extracted parameter. A warning is weak evidence of
 * a degraded answer, so it costs a little reliability, not a lot.
 */
const WARNING_PENALTY = 0.03;
const MAX_PENALISED_WARNINGS = 2;

export const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : 0);

/**
 * Reliability of one acquired item, 0..1.
 * Every factor is drawn from something the Telegraph exchange actually
 * reported — nothing here is assumed.
 */
export function scoreReliability(
  record: TelegraphAskRecord,
  quality: EvidenceQuality,
): { reliability: number; notes: string[] } {
  const def = getIntent(record.requestedIntent);
  if (!def) {
    throw new ConfidenceEvaluationError(
      `Cannot score evidence for unregistered intent "${record.requestedIntent}".`,
      { intent: record.requestedIntent },
    );
  }

  const notes: string[] = [];
  let reliability = TIER_RELIABILITY[def.tier];
  notes.push(`tier ${def.tier} base ${reliability.toFixed(2)}`);

  reliability *= QUALITY_FACTOR[quality];
  notes.push(`read quality ${quality} x${QUALITY_FACTOR[quality]}`);

  // Deycid asks in natural language and Telegraph's router decides the intent.
  // Landing somewhere else is a genuine relevance signal, not an error.
  if (record.routedIntent && record.routedIntent !== record.requestedIntent) {
    reliability *= ROUTING_MISMATCH_FACTOR;
    notes.push(`routed to ${record.routedIntent}, not ${record.requestedIntent} x${ROUTING_MISMATCH_FACTOR}`);
  }

  if (!record.signalHash) {
    reliability *= NO_SIGNAL_HASH_FACTOR;
    notes.push(`no signal hash recorded x${NO_SIGNAL_HASH_FACTOR}`);
  }

  if (record.warnings.length > 0) {
    const capped = Math.min(record.warnings.length, MAX_PENALISED_WARNINGS);
    const factor = 1 - WARNING_PENALTY * capped;
    reliability *= factor;
    notes.push(`${capped} Telegraph warning(s) x${factor.toFixed(2)}`);
  }

  return { reliability: clamp01(reliability), notes };
}

/**
 * Relevance of an intent to this case, 0..1.
 * The registry's base relevance is lifted when the intent speaks directly to a
 * fact the case actually carries — a transaction lookup matters more when there
 * is a transaction hash to look up.
 */
export function scoreRelevance(intentName: string, facets: CaseFacets): number {
  const def = getIntent(intentName);
  if (!def) return 0;

  let relevance = def.baseRelevance;

  const anchored =
    (def.requires.includes('transactionHash') && Boolean(facets.transactionHash)) ||
    (def.requires.includes('actingAddress') && Boolean(facets.actingAddress)) ||
    (def.requires.includes('address') && facets.addresses.length > 0) ||
    (def.requires.includes('url') && facets.urls.length > 0) ||
    (def.requires.includes('asset') && facets.assets.length > 0) ||
    (def.requires.includes('subject') && facets.subjects.length > 0) ||
    (def.requires.includes('chain') && Boolean(facets.chain));

  // An intent reachable only through a weaker anchor than it wants is still
  // worth something, but not full relevance.
  relevance = anchored ? Math.min(1, relevance * 1.1) : relevance * 0.5;

  return clamp01(relevance);
}

/**
 * Freshness discount, 0..1, by exponential decay on the intent's half-life.
 * Exactly 0.5 at one half-life. `now` is injectable so tests are not clock
 * dependent.
 */
export function scoreFreshness(intentName: string, observedAtIso: string, now: number = Date.now()): number {
  const def = getIntent(intentName);
  if (!def) return 0;

  const observed = Date.parse(observedAtIso);
  if (!Number.isFinite(observed)) return 0.5;

  const ageSeconds = Math.max(0, (now - observed) / 1000);
  return clamp01(Math.pow(2, -ageSeconds / def.halfLifeSeconds));
}

const DIRECTIONAL: readonly EvidenceStance[] = ['SUPPORTS', 'CONTRADICTS'];

/**
 * Aggregates all collected evidence for a case into a single assessment.
 *
 * Failed items are excluded outright. Non-directional items (NEUTRAL,
 * UNCERTAIN) are counted in the rationale but contribute no mass, so a pile of
 * unreadable answers can never masquerade as confidence.
 */
export function assessConfidence(
  evidence: readonly EvidenceItem[],
  policy: DecisionPolicy,
): ConfidenceAssessment {
  const usable = evidence.filter((e) => e.status === 'COLLECTED');
  const directional = usable.filter((e) => DIRECTIONAL.includes(e.stance));

  const supportMass = directional
    .filter((e) => e.stance === 'SUPPORTS')
    .reduce((sum, e) => sum + e.weight, 0);
  const contradictMass = directional
    .filter((e) => e.stance === 'CONTRADICTS')
    .reduce((sum, e) => sum + e.weight, 0);

  const totalMass = supportMass + contradictMass;
  const rationale: string[] = [];

  const nonDirectional = usable.length - directional.length;
  rationale.push(
    `${usable.length} usable item(s): ${directional.length} directional, ${nonDirectional} neutral/uncertain.`,
  );

  if (totalMass <= 0) {
    rationale.push('No directional evidence. Deycid confidence is 0 — nothing has been established either way.');
    return {
      confidence: 0,
      direction: 'NONE',
      supportMass: 0,
      contradictMass: 0,
      contradictionRatio: 0,
      materialConflict: false,
      agreement: 0,
      evidenceStrength: 0,
      corroboration: 0,
      distinctIntents: 0,
      rationale,
    };
  }

  const direction: 'SUPPORT' | 'CONTRADICT' = supportMass >= contradictMass ? 'SUPPORT' : 'CONTRADICT';
  const agreement = Math.max(supportMass, contradictMass) / totalMass;
  const contradictionRatio = Math.min(supportMass, contradictMass) / totalMass;

  const distinctIntents = new Set(directional.map((e) => e.requestedIntent)).size;
  const corroboration = 1 - Math.exp(-DISTINCT_RATE * distinctIntents);
  const evidenceStrength = 1 - Math.exp(-totalMass / MASS_SCALE);

  const penalty = clamp01(1 - contradictionRatio * policy.contradictionPenaltyWeight);
  const confidence = Math.min(
    CONFIDENCE_CEILING,
    clamp01(evidenceStrength * agreement * corroboration * penalty),
  );

  const materialConflict = contradictionRatio > policy.maxContradictionRatio;

  rationale.push(
    `Support mass ${supportMass.toFixed(3)} vs contradiction mass ${contradictMass.toFixed(3)} — leaning ${direction}.`,
  );
  rationale.push(
    `Evidence strength ${evidenceStrength.toFixed(3)} (saturating in total weight ${totalMass.toFixed(3)}).`,
  );
  rationale.push(
    `Corroboration ${corroboration.toFixed(3)} from ${distinctIntents} distinct intent(s); agreement ${agreement.toFixed(3)}.`,
  );
  rationale.push(
    `Contradiction ratio ${contradictionRatio.toFixed(3)} x policy weight ${policy.contradictionPenaltyWeight} ` +
      `-> penalty factor ${penalty.toFixed(3)}.`,
  );
  if (materialConflict) {
    rationale.push(
      `Contradiction ratio exceeds the policy tolerance of ${policy.maxContradictionRatio} — material conflict.`,
    );
  }
  rationale.push(`Deycid confidence = ${confidence.toFixed(4)}.`);

  return {
    confidence,
    direction,
    supportMass,
    contradictMass,
    contradictionRatio,
    materialConflict,
    agreement,
    evidenceStrength,
    corroboration,
    distinctIntents,
    rationale,
  };
}

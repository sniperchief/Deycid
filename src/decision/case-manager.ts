import { InvalidDecisionError, isDeycidError, CaseNotFoundError } from '../errors.js';
import type { TelegraphClientLike } from '../telegraph/client.js';
import { getIntent } from '../telegraph/intents.js';
import { normalizeResult } from '../telegraph/normalizer.js';
import type {
  BudgetState,
  CaseState,
  DecisionCase,
  DecisionRequest,
  RiskTolerance,
  Verdict,
} from '../types/case.js';
import type { EvidenceItem } from '../types/evidence.js';
import type { UsageLog } from '../usage/log.js';
import { caseNumber, newId, nextCaseId } from '../utils/ids.js';
import { demo, logger } from '../utils/logger.js';
import {
  assessConfidence,
  scoreFreshness,
  scoreRelevance,
  scoreReliability,
} from './confidence-engine.js';
import { extractFacets, planRound, shouldContinueResearch, type CandidateEvaluation } from './evidence-strategy.js';
import { getPolicy, resolveCaseParameters, type DecisionPolicy } from './policy-engine.js';

/**
 * Runs the intelligence acquisition loop.
 *
 *   propose -> plan a round -> buy intelligence -> normalize -> score ->
 *   enough? -> verdict : another round
 *
 * Cases are held in memory for the life of the process. That is a deliberate
 * MVP choice: Deycid is a local MCP server, and a database would add operational
 * surface without changing what the product demonstrates.
 */

export interface EvaluateInput {
  decision: string;
  context?: string;
  chain?: string;
  transactionHash?: string;
  actingAddress?: string;
  riskTolerance?: RiskTolerance;
  confidenceThreshold?: number;
  intelligenceBudgetUsdc?: number;
  maxRounds?: number;
}

/**
 * Progress during a run.
 *
 * A multi-round evaluation routinely takes longer than an MCP client's default
 * 60-second request timeout — a real live run was cut off at exactly that mark.
 * Emitting progress lets a client reset its deadline (and shows the user what
 * Deycid is buying while it waits).
 */
export interface ProgressUpdate {
  /** Monotonic count of intelligence requests completed. */
  completed: number;
  round: number;
  message: string;
}

export type ProgressReporter = (update: ProgressUpdate) => void;

export interface CaseManagerDefaults {
  /** Operator default. Undefined means the risk policy's band applies. */
  confidenceThreshold?: number;
  intelligenceBudgetUsdc: number;
  maxRounds: number;
}

/** Aggregate telemetry, derived only from cases this process actually ran. */
export interface DeycidTelemetry {
  totalCases: number;
  activeCases: number;
  completedCases: number;
  totalIntelligenceRequests: number;
  failedIntelligenceRequests: number;
  totalSpentUsdc: number;
  averageConfidence: number | null;
  averageRoundsPerCase: number | null;
  verdictCounts: Record<Verdict, number>;
}

export class CaseManager {
  readonly #cases = new Map<string, DecisionCase>();
  readonly #telegraph: TelegraphClientLike;
  readonly #defaults: CaseManagerDefaults;
  readonly #usage: UsageLog | undefined;

  constructor(telegraph: TelegraphClientLike, defaults: CaseManagerDefaults, usage?: UsageLog) {
    this.#telegraph = telegraph;
    this.#defaults = defaults;
    this.#usage = usage;
  }

  getCase(caseId: string): DecisionCase {
    const found = this.#cases.get(caseId);
    if (!found) throw new CaseNotFoundError(caseId);
    return found;
  }

  listCases(): DecisionCase[] {
    return [...this.#cases.values()];
  }

  /** Creates a case without running it. Exposed so the loop stays inspectable. */
  createCase(input: EvaluateInput): DecisionCase {
    const decision = input.decision?.trim() ?? '';
    if (decision.length < 8) {
      throw new InvalidDecisionError('`decision` must be a question of at least 8 characters.', {
        received: decision.length,
      });
    }
    if (input.transactionHash && !/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash)) {
      throw new InvalidDecisionError('`transactionHash` must be a 0x-prefixed 32-byte hex string.', {});
    }
    if (input.actingAddress && !/^0x[0-9a-fA-F]{40}$/.test(input.actingAddress)) {
      throw new InvalidDecisionError('`actingAddress` must be a 0x-prefixed 20-byte hex address.', {});
    }

    const riskTolerance: RiskTolerance = input.riskTolerance ?? 'medium';
    const policy = getPolicy(riskTolerance);
    const resolved = resolveCaseParameters(
      policy,
      {
        ...(input.confidenceThreshold !== undefined ? { confidenceThreshold: input.confidenceThreshold } : {}),
        ...(input.intelligenceBudgetUsdc !== undefined
          ? { intelligenceBudgetUsdc: input.intelligenceBudgetUsdc }
          : {}),
        ...(input.maxRounds !== undefined ? { maxRounds: input.maxRounds } : {}),
      },
      this.#defaults,
    );

    if (resolved.intelligenceBudgetUsdc <= 0) {
      throw new InvalidDecisionError('`intelligenceBudgetUsdc` must be greater than zero.', {});
    }

    const request: DecisionRequest = {
      decision,
      riskTolerance,
      confidenceThreshold: resolved.confidenceThreshold,
      intelligenceBudgetUsdc: resolved.intelligenceBudgetUsdc,
      maxRounds: resolved.maxRounds,
      ...(input.context ? { context: input.context } : {}),
      ...(input.chain ? { chain: input.chain } : {}),
      ...(input.transactionHash ? { transactionHash: input.transactionHash } : {}),
      ...(input.actingAddress ? { actingAddress: input.actingAddress } : {}),
    };

    const facets = extractFacets({
      decision,
      ...(input.context ? { context: input.context } : {}),
      ...(input.chain ? { chain: input.chain } : {}),
      ...(input.transactionHash ? { transactionHash: input.transactionHash } : {}),
      ...(input.actingAddress ? { actingAddress: input.actingAddress } : {}),
    });

    const budget: BudgetState = {
      allocatedUsdc: resolved.intelligenceBudgetUsdc,
      spentUsdc: 0,
      remainingUsdc: resolved.intelligenceBudgetUsdc,
    };

    const now = new Date().toISOString();
    const decisionCase: DecisionCase = {
      id: nextCaseId(),
      state: 'CREATED',
      request,
      facets,
      policyName: policy.name,
      budget,
      roundsUsed: 0,
      evidence: [],
      payments: [],
      createdAt: now,
      timeline: [{ at: now, state: 'CREATED' }],
    };

    this.#cases.set(decisionCase.id, decisionCase);

    logger.info('case.created', {
      caseId: decisionCase.id,
      policy: policy.name,
      confidenceTarget: request.confidenceThreshold,
      budgetUsdc: budget.allocatedUsdc,
      maxRounds: request.maxRounds,
      facets: {
        hasTransaction: Boolean(facets.transactionHash),
        hasActingAddress: Boolean(facets.actingAddress),
        counterpartyAddresses: facets.addresses.length,
        assets: facets.assets,
        subjects: facets.subjects,
        urls: facets.urls.length,
      },
    });

    demo(`Case ${caseNumber(decisionCase.id)} created`);
    demo(`Confidence target: ${Math.round(request.confidenceThreshold * 100)}%`);
    demo(`Intelligence budget: $${budget.allocatedUsdc.toFixed(2)} (policy ${policy.name})`);

    return decisionCase;
  }

  /** Creates a case and runs the acquisition loop to a terminal state. */
  async evaluate(input: EvaluateInput, onProgress?: ProgressReporter): Promise<DecisionCase> {
    const decisionCase = this.createCase(input);
    return this.runCase(decisionCase.id, onProgress);
  }

  async runCase(caseId: string, onProgress?: ProgressReporter): Promise<DecisionCase> {
    const c = this.getCase(caseId);
    const policy = getPolicy(c.request.riskTolerance);

    // A reporter that can never break the run it is describing.
    const report: ProgressReporter = (update) => {
      if (!onProgress) return;
      try {
        onProgress(update);
      } catch {
        // Progress is advisory; a transport hiccup must not fail the decision.
      }
    };

    try {
      for (;;) {
        const plan = planRound(c, policy);

        if (plan.selected.length === 0) {
          const reason =
            c.evidence.length === 0
              ? 'No intent in the registry can be answered from the facts supplied. ' +
                'Provide a transaction hash, an address, an asset symbol, a URL or a known protocol name.'
              : 'No affordable intelligence left to buy.';
          this.#stop(c, c.evidence.length === 0 ? 'FAILED' : 'BUDGET_EXHAUSTED', reason);
          break;
        }

        this.#transition(c, 'RESEARCHING', `Round ${c.roundsUsed + 1}`);
        c.roundsUsed += 1;
        demo(`Opening evidence round ${c.roundsUsed}`);

        const collectedBefore = c.evidence.filter((e) => e.status === 'COLLECTED').length;
        await this.#runRound(c, plan.selected, report);
        const collectedThisRound =
          c.evidence.filter((e) => e.status === 'COLLECTED').length - collectedBefore;

        // A round that acquired nothing at all means the network is not
        // answering. Spending further rounds re-asking would add no evidence —
        // the failures are already recorded — so stop and say so.
        if (collectedThisRound === 0) {
          this.#transition(c, 'EVALUATING');
          c.assessment = assessConfidence(c.evidence, policy);
          this.#finalize(
            c,
            policy,
            'Round acquired no usable intelligence; every request in it failed.',
          );
          break;
        }

        this.#transition(c, 'EVALUATING');
        const assessment = assessConfidence(c.evidence, policy);
        c.assessment = assessment;

        logger.info('confidence.updated', {
          caseId: c.id,
          round: c.roundsUsed,
          deycidConfidence: Number(assessment.confidence.toFixed(4)),
          target: c.request.confidenceThreshold,
          direction: assessment.direction,
          contradictionRatio: Number(assessment.contradictionRatio.toFixed(4)),
        });
        demo(
          `Aggregate Deycid confidence: ${Math.round(assessment.confidence * 100)}% ` +
            `(target ${Math.round(c.request.confidenceThreshold * 100)}%)`,
        );

        if (assessment.materialConflict) {
          logger.warn('contradiction.detected', {
            caseId: c.id,
            contradictionRatio: Number(assessment.contradictionRatio.toFixed(4)),
            tolerance: policy.maxContradictionRatio,
          });
          demo('MATERIAL CONFLICT DETECTED — additional intelligence required');
        }

        const next = shouldContinueResearch(c, policy);
        if (!next.proceed) {
          this.#finalize(c, policy, next.reason);
          break;
        }

        this.#transition(c, 'NEEDS_MORE_EVIDENCE', next.reason);
        logger.info('research.escalated', { caseId: c.id, round: c.roundsUsed, reason: next.reason });
        demo(`Evidence insufficient — ${next.reason}`);
      }
    } catch (err) {
      const message = isDeycidError(err) ? err.message : err instanceof Error ? err.message : String(err);
      c.error = message;
      this.#stop(c, 'FAILED', message);
      logger.error('decision.failed', { caseId: c.id, error: message });
      demo(`Case ${caseNumber(c.id)} FAILED: ${message}`);
    }

    return c;
  }

  /** Buys the planned intents for one round, sequentially. */
  async #runRound(
    c: DecisionCase,
    selected: CandidateEvaluation[],
    report: ProgressReporter,
  ): Promise<void> {
    for (const candidate of selected) {
      // Re-check immediately before spending: an earlier item in this same
      // round may have cost more than its estimate.
      if (candidate.estimatedCostUsdc > c.budget.remainingUsdc) {
        logger.warn('research.stopped', {
          caseId: c.id,
          intent: candidate.intent,
          reason: 'estimated cost exceeds remaining budget',
          remainingUsdc: c.budget.remainingUsdc,
        });
        break;
      }

      demo(`Requesting ${candidate.intent}`);
      report({
        completed: c.evidence.length,
        round: c.roundsUsed,
        message: `Round ${c.roundsUsed}: requesting ${candidate.intent}`,
      });

      try {
        const outcome = await this.#telegraph.askIntent(
          candidate.intent,
          candidate.query,
          candidate.context,
        );

        if (outcome.receipt) {
          c.payments.push(outcome.receipt);
          // Charged even when the facilitator reported the settlement as
          // failed. Telegraph settles only on success, so that combination
          // should not arise; if it ever does, over-counting spend protects the
          // budget, whereas under-counting would let a case quietly overrun it.
          this.#spend(c, outcome.receipt.amountUsdc);

          // Local record of a call Telegraph has already published as a Signal.
          // Written to disk only; never transmitted by Deycid.
          this.#usage?.record({
            at: new Date().toISOString(),
            caseId: c.id,
            wallet: outcome.receipt.payer ?? '',
            requestedIntent: candidate.intent,
            amountUsdc: outcome.receipt.amountUsdc,
            network: outcome.receipt.network,
            ...(outcome.record.routedIntent ? { routedIntent: outcome.record.routedIntent } : {}),
            ...(outcome.record.minerName ? { minerName: outcome.record.minerName } : {}),
            ...(outcome.record.signalHash ? { signalHash: outcome.record.signalHash } : {}),
          });
        } else if (typeof outcome.record.costUsd === 'number') {
          // No settlement proof captured but Telegraph reported a cost; charge
          // the case for what the node says it billed rather than nothing.
          this.#spend(c, outcome.record.costUsd);
        }

        const item = this.#buildEvidence(c, candidate, outcome.record);
        c.evidence.push(item);

        logger.info('evidence.added', {
          caseId: c.id,
          evidenceId: item.id,
          requestedIntent: item.requestedIntent,
          routedIntent: item.routedIntent,
          stance: item.stance,
          quality: item.quality,
          deycidConfidence: Number(item.deycidConfidence.toFixed(4)),
        });
        demo(
          `Intelligence received — ${item.stance} (Deycid item confidence ` +
            `${Math.round(item.deycidConfidence * 100)}%, ${item.quality} read)`,
        );
      } catch (err) {
        const message = isDeycidError(err) ? err.message : err instanceof Error ? err.message : String(err);

        // A failed purchase is recorded, not swallowed. It carries no weight but
        // it is visible in the receipt, so a thin decision is explainable.
        const failed: EvidenceItem = {
          id: newId('ev'),
          round: c.roundsUsed,
          requestedIntent: candidate.intent,
          tier: getIntent(candidate.intent)?.tier ?? 'B_LLM_JUDGE',
          status: 'FAILED',
          stance: 'UNCERTAIN',
          quality: 'LOW',
          finding: `Acquisition failed: ${message}`,
          matchedSignals: [],
          reliability: 0,
          relevance: 0,
          freshness: 0,
          weight: 0,
          deycidConfidence: 0,
          costUsd: 0,
          error: message,
          createdAt: new Date().toISOString(),
          source: {
            requestId: newId('req'),
            requestedIntent: candidate.intent,
            result: null,
            warnings: [],
            receivedAt: new Date().toISOString(),
          },
        };
        c.evidence.push(failed);

        logger.warn('intelligence.failed', { caseId: c.id, intent: candidate.intent, error: message });
        demo(`${candidate.intent} failed: ${message}`);

        // A wallet or payment fault will hit every subsequent purchase in this
        // round the same way; stop rather than burn the loop on it.
        if (isDeycidError(err) && (err.code === 'WALLET_UNAVAILABLE' || err.code === 'X402_PAYMENT_FAILED')) {
          throw err;
        }
      }
    }
  }

  #buildEvidence(
    c: DecisionCase,
    candidate: CandidateEvaluation,
    record: Parameters<typeof scoreReliability>[0],
  ): EvidenceItem {
    // The query is handed to the normalizer so a miner echoing the prompt back
    // cannot have Deycid's own question read as the miner's answer.
    const normalized = normalizeResult(record.result, record.warnings, candidate.query);
    const { reliability } = scoreReliability(record, normalized.quality);
    const relevance = scoreRelevance(candidate.intent, c.facets);
    const observedAt = record.telegraphTimestamp ?? record.receivedAt;
    const freshness = scoreFreshness(candidate.intent, observedAt);
    const weight = reliability * relevance * freshness;

    return {
      id: newId('ev'),
      round: c.roundsUsed,
      requestedIntent: candidate.intent,
      ...(record.routedIntent ? { routedIntent: record.routedIntent } : {}),
      tier: getIntent(candidate.intent)?.tier ?? 'B_LLM_JUDGE',
      status: 'COLLECTED',
      stance: normalized.stance,
      quality: normalized.quality,
      finding: normalized.finding,
      matchedSignals: normalized.matchedSignals,
      reliability,
      relevance,
      freshness,
      weight,
      deycidConfidence: weight,
      costUsd: record.costUsd ?? 0,
      source: record,
      createdAt: new Date().toISOString(),
    };
  }

  /** Records spend. Remaining budget is floored at zero and never goes negative. */
  #spend(c: DecisionCase, amountUsdc: number): void {
    if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) return;
    c.budget.spentUsdc = Number((c.budget.spentUsdc + amountUsdc).toFixed(6));
    c.budget.remainingUsdc = Number(Math.max(0, c.budget.allocatedUsdc - c.budget.spentUsdc).toFixed(6));
  }

  /** Turns the final assessment into a verdict and a terminal state. */
  #finalize(c: DecisionCase, policy: DecisionPolicy, reason: string): void {
    const assessment = c.assessment;
    this.#transition(c, 'DECISION_READY', reason);

    const targetMet =
      assessment !== undefined &&
      assessment.direction !== 'NONE' &&
      assessment.confidence >= c.request.confidenceThreshold &&
      !assessment.materialConflict &&
      assessment.distinctIntents >= policy.minDistinctIntents;

    let verdict: Verdict;
    let finalState: CaseState;

    if (targetMet && assessment.direction === 'SUPPORT') {
      verdict = 'APPROVE';
      finalState = 'APPROVED';
    } else if (targetMet && assessment.direction === 'CONTRADICT') {
      verdict = 'REJECT';
      finalState = 'REJECTED';
    } else {
      // Fail closed. Not reaching the bar is never a soft approve.
      verdict = 'ABSTAIN';
      if (c.roundsUsed >= c.request.maxRounds) finalState = 'MAX_ROUNDS_REACHED';
      else finalState = 'BUDGET_EXHAUSTED';
    }

    c.verdict = verdict;
    this.#stop(c, finalState, reason);

    logger.info('decision.completed', {
      caseId: c.id,
      verdict,
      state: finalState,
      deycidConfidence: assessment ? Number(assessment.confidence.toFixed(4)) : 0,
      target: c.request.confidenceThreshold,
      spentUsdc: c.budget.spentUsdc,
      rounds: c.roundsUsed,
    });
    demo(`VERDICT: ${verdict} (${reason})`);
  }

  #transition(c: DecisionCase, state: CaseState, note?: string): void {
    c.state = state;
    c.timeline.push({ at: new Date().toISOString(), state, ...(note ? { note } : {}) });
  }

  #stop(c: DecisionCase, state: CaseState, reason: string): void {
    c.stopReason = reason;
    c.completedAt = new Date().toISOString();
    if (!c.verdict) c.verdict = 'ABSTAIN';
    this.#transition(c, state, reason);
    logger.info('research.stopped', { caseId: c.id, state, reason });
  }

  /** Telemetry over the cases this process has actually run. Never synthesized. */
  getTelemetry(): DeycidTelemetry {
    const cases = this.listCases();
    const completed = cases.filter((c) => c.completedAt !== undefined);
    const allEvidence = cases.flatMap((c) => c.evidence);
    const confidences = completed
      .map((c) => c.assessment?.confidence)
      .filter((n): n is number => typeof n === 'number');

    const verdictCounts: Record<Verdict, number> = { APPROVE: 0, REJECT: 0, ABSTAIN: 0 };
    for (const c of completed) {
      if (c.verdict) verdictCounts[c.verdict] += 1;
    }

    return {
      totalCases: cases.length,
      activeCases: cases.length - completed.length,
      completedCases: completed.length,
      totalIntelligenceRequests: allEvidence.length,
      failedIntelligenceRequests: allEvidence.filter((e) => e.status === 'FAILED').length,
      totalSpentUsdc: Number(cases.reduce((sum, c) => sum + c.budget.spentUsdc, 0).toFixed(6)),
      averageConfidence:
        confidences.length > 0
          ? Number((confidences.reduce((a, b) => a + b, 0) / confidences.length).toFixed(4))
          : null,
      averageRoundsPerCase:
        completed.length > 0
          ? Number((completed.reduce((s, c) => s + c.roundsUsed, 0) / completed.length).toFixed(2))
          : null,
      verdictCounts,
    };
  }
}

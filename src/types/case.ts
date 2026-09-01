import { z } from 'zod';
import type { ConfidenceAssessment, EvidenceItem } from './evidence.js';
import type { PaymentReceipt } from './payment.js';

/** Lifecycle of a decision case. Never represented as a bare string elsewhere. */
export const CaseStateSchema = z.enum([
  'CREATED',
  'RESEARCHING',
  'EVALUATING',
  'NEEDS_MORE_EVIDENCE',
  'DECISION_READY',
  'APPROVED',
  'REJECTED',
  'BUDGET_EXHAUSTED',
  'MAX_ROUNDS_REACHED',
  'FAILED',
]);
export type CaseState = z.infer<typeof CaseStateSchema>;

/** States a case can no longer advance from. */
export const TERMINAL_CASE_STATES: readonly CaseState[] = [
  'APPROVED',
  'REJECTED',
  'BUDGET_EXHAUSTED',
  'MAX_ROUNDS_REACHED',
  'FAILED',
] as const;

/**
 * The actionable answer.
 *
 * ABSTAIN is a first-class outcome, not a failure: it means Deycid did not
 * reach its confidence target within the budget and rounds it was given.
 * Deycid fails closed — an ABSTAIN must be read by the calling agent as
 * "do not execute", never as a soft approve.
 */
export const VerdictSchema = z.enum(['APPROVE', 'REJECT', 'ABSTAIN']);
export type Verdict = z.infer<typeof VerdictSchema>;

/** Caller's appetite for acting on thin evidence. Selects a decision policy. */
export const RiskToleranceSchema = z.enum(['low', 'medium', 'high']);
export type RiskTolerance = z.infer<typeof RiskToleranceSchema>;

/**
 * Structured facts pulled out of the caller's decision text and fields.
 * Drives which intents are worth buying — see decision/evidence-strategy.ts.
 */
export interface CaseFacets {
  chain?: string;
  transactionHash?: string;
  /**
   * The wallet that would execute the action, when the caller names one.
   *
   * Kept separate from `addresses` because the two answer different questions.
   * "Can this wallet afford it?" is about the acting wallet; "is this
   * counterparty dangerous?" is about the others. Conflating them produced a
   * real misread on the first live run: Deycid checked the balance of the Aave
   * pool contract and read its 0 ETH as the caller being unable to pay.
   */
  actingAddress?: string;
  /** Counterparty addresses — contracts, recipients. Never the acting wallet. */
  addresses: string[];
  /** Uppercase token symbols recognised from a documented list. */
  assets: string[];
  urls: string[];
  /** Free-text protocol/project names worth researching. */
  subjects: string[];
}

export interface DecisionRequest {
  decision: string;
  context?: string;
  chain?: string;
  transactionHash?: string;
  /** Wallet that would execute the action, if the caller named one. */
  actingAddress?: string;
  riskTolerance: RiskTolerance;
  confidenceThreshold: number;
  intelligenceBudgetUsdc: number;
  maxRounds: number;
}

export interface BudgetState {
  allocatedUsdc: number;
  spentUsdc: number;
  remainingUsdc: number;
}

export interface DecisionCase {
  id: string;
  state: CaseState;
  request: DecisionRequest;
  facets: CaseFacets;
  policyName: string;
  budget: BudgetState;
  roundsUsed: number;
  evidence: EvidenceItem[];
  payments: PaymentReceipt[];
  assessment?: ConfidenceAssessment;
  verdict?: Verdict;
  /** Why the case stopped when it did. */
  stopReason?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
  /** Ordered state transitions, for the demo log and the receipt. */
  timeline: { at: string; state: CaseState; note?: string }[];
}

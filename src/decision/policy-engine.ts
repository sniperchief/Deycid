import type { RiskTolerance } from '../types/case.js';

/**
 * Decision policies.
 *
 * A policy bundles everything the caller's risk appetite should control:
 * how much confidence is required, how much disagreement is tolerated before
 * research is reopened, how many rounds and how much money may be spent, and
 * how hard a contradiction bites.
 *
 * Naming note. The MCP tool takes a `riskTolerance`, so the bands here are keyed
 * by tolerance and are monotonic: the *less* risk a caller will tolerate, the
 * *more* confidence Deycid must reach before it will approve. A caller who
 * passes an explicit `confidenceThreshold` overrides the band; the rest of the
 * policy still applies.
 */
export interface DecisionPolicy {
  name: string;
  riskTolerance: RiskTolerance;
  /** Confidence required to return a non-ABSTAIN verdict, 0..1. */
  confidenceTarget: number;
  /**
   * Largest tolerated `min(S,C)/(S+C)`. Above this the evidence is judged to be
   * in material conflict and another round is opened regardless of confidence.
   */
  maxContradictionRatio: number;
  /**
   * Multiplier on the contradiction penalty. Cautious policies punish
   * disagreement harder.
   */
  contradictionPenaltyWeight: number;
  /** Distinct intents that should corroborate before approving. */
  minDistinctIntents: number;
  /** Ceiling on a case's intelligence budget, in USDC. */
  maxIntelligenceBudgetUsdc: number;
  /** Ceiling on evidence rounds. */
  maxRounds: number;
  /** How many intents to buy in one round. */
  intentsPerRound: number;
  description: string;
}

const POLICIES: Record<RiskTolerance, DecisionPolicy> = {
  low: {
    name: 'LOW_RISK_TOLERANCE',
    riskTolerance: 'low',
    confidenceTarget: 0.95,
    maxContradictionRatio: 0.1,
    contradictionPenaltyWeight: 1.8,
    minDistinctIntents: 3,
    maxIntelligenceBudgetUsdc: 1.0,
    maxRounds: 4,
    intentsPerRound: 3,
    description:
      'Cautious. Demands near-certainty and treats any real disagreement as disqualifying. ' +
      'For irreversible or high-value on-chain actions.',
  },
  medium: {
    name: 'MEDIUM_RISK_TOLERANCE',
    riskTolerance: 'medium',
    confidenceTarget: 0.9,
    maxContradictionRatio: 0.2,
    contradictionPenaltyWeight: 1.3,
    minDistinctIntents: 2,
    maxIntelligenceBudgetUsdc: 0.5,
    maxRounds: 3,
    intentsPerRound: 3,
    description: 'Balanced default. Corroboration from two independent intents is enough.',
  },
  high: {
    name: 'HIGH_RISK_TOLERANCE',
    riskTolerance: 'high',
    confidenceTarget: 0.8,
    maxContradictionRatio: 0.3,
    contradictionPenaltyWeight: 1.0,
    minDistinctIntents: 1,
    maxIntelligenceBudgetUsdc: 0.25,
    maxRounds: 2,
    intentsPerRound: 2,
    description:
      'Permissive. Acts on a single strong signal. For reversible or low-value actions ' +
      'where the cost of over-researching exceeds the cost of being wrong.',
  },
};

export function getPolicy(riskTolerance: RiskTolerance): DecisionPolicy {
  return POLICIES[riskTolerance];
}

export function listPolicies(): DecisionPolicy[] {
  return Object.values(POLICIES);
}

/**
 * Applies a policy's ceilings to a caller's requested parameters.
 *
 * The caller may always ask for *stricter* terms than the policy; they may not
 * exceed its budget or round ceilings.
 *
 * Confidence-threshold precedence, strongest first:
 *   1. the value passed on the individual case
 *   2. the operator's `DEFAULT_CONFIDENCE_THRESHOLD`, when one is set
 *   3. the risk policy's own band
 *
 * Step 2 has to be distinguishable from "unset" for the operator default to
 * mean anything — an earlier version defaulted it to a number, so the policy
 * band always won and the environment variable was silently inert.
 */
export function resolveCaseParameters(
  policy: DecisionPolicy,
  requested: {
    confidenceThreshold?: number;
    intelligenceBudgetUsdc?: number;
    maxRounds?: number;
  },
  defaults: {
    confidenceThreshold?: number;
    intelligenceBudgetUsdc: number;
    maxRounds: number;
  },
): { confidenceThreshold: number; intelligenceBudgetUsdc: number; maxRounds: number } {
  const confidenceThreshold = clamp01(
    requested.confidenceThreshold ?? defaults.confidenceThreshold ?? policy.confidenceTarget,
  );

  const budget = Math.min(
    requested.intelligenceBudgetUsdc ?? defaults.intelligenceBudgetUsdc,
    policy.maxIntelligenceBudgetUsdc,
  );

  const rounds = Math.min(requested.maxRounds ?? defaults.maxRounds, policy.maxRounds);

  return {
    confidenceThreshold,
    intelligenceBudgetUsdc: Math.max(budget, 0),
    maxRounds: Math.max(1, Math.floor(rounds)),
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.9;
  return Math.min(Math.max(n, 0.01), 0.99);
}

import { describe, expect, it } from 'vitest';
import {
  evaluateCandidates,
  extractFacets,
  planRound,
  shouldContinueResearch,
} from '../src/decision/evidence-strategy.js';
import { getPolicy } from '../src/decision/policy-engine.js';
import type { DecisionCase } from '../src/types/case.js';
import type { EvidenceItem, EvidenceStance } from '../src/types/evidence.js';

const TX = `0x${'a'.repeat(64)}`;
const ADDR = `0x${'b'.repeat(40)}`;

function makeCase(overrides: Partial<DecisionCase> = {}): DecisionCase {
  const facets = overrides.facets ?? extractFacets({ decision: 'Should I execute this?', transactionHash: TX });
  return {
    id: 'case-1',
    state: 'CREATED',
    request: {
      decision: 'Should I execute this transaction?',
      riskTolerance: 'medium',
      confidenceThreshold: 0.9,
      intelligenceBudgetUsdc: 0.1,
      maxRounds: 3,
    },
    facets,
    policyName: 'MEDIUM_RISK_TOLERANCE',
    budget: { allocatedUsdc: 0.1, spentUsdc: 0, remainingUsdc: 0.1 },
    roundsUsed: 0,
    evidence: [],
    payments: [],
    createdAt: new Date().toISOString(),
    timeline: [],
    ...overrides,
  };
}

function ev(intent: string, stance: EvidenceStance = 'SUPPORTS'): EvidenceItem {
  return {
    id: `ev-${intent}-${Math.random()}`,
    round: 1,
    requestedIntent: intent,
    tier: 'A_DETERMINISTIC',
    status: 'COLLECTED',
    stance,
    quality: 'HIGH',
    finding: 'x',
    matchedSignals: [],
    reliability: 0.9,
    relevance: 1,
    freshness: 1,
    weight: 0.9,
    deycidConfidence: 0.9,
    costUsd: 0.01,
    createdAt: new Date().toISOString(),
    source: {
      requestId: 'r',
      requestedIntent: intent,
      result: {},
      warnings: [],
      receivedAt: new Date().toISOString(),
    },
  };
}

describe('extractFacets', () => {
  it('pulls a transaction hash out of free text', () => {
    const f = extractFacets({ decision: `Is ${TX} safe to submit?` });
    expect(f.transactionHash).toBe(TX);
  });

  it('prefers the explicit transactionHash field over scraped text', () => {
    const other = `0x${'c'.repeat(64)}`;
    const f = extractFacets({ decision: `Look at ${TX}`, transactionHash: other });
    expect(f.transactionHash).toBe(other);
  });

  it('does not mistake part of a transaction hash for an address', () => {
    const f = extractFacets({ decision: `Transaction ${TX}` });
    expect(f.addresses).toEqual([]);
  });

  it('extracts addresses, assets, urls and known protocols', () => {
    const f = extractFacets({
      decision: `Should I send USDC to ${ADDR} via Aave?`,
      context: 'See https://example.com/pool for details.',
    });
    expect(f.addresses).toContain(ADDR);
    expect(f.assets).toContain('USDC');
    expect(f.subjects).toContain('aave');
    expect(f.urls).toContain('https://example.com/pool');
  });

  it('returns empty collections when the decision carries no facts', () => {
    const f = extractFacets({ decision: 'Should I do the thing?' });
    expect(f.addresses).toEqual([]);
    expect(f.assets).toEqual([]);
    expect(f.subjects).toEqual([]);
    expect(f.transactionHash).toBeUndefined();
  });
});

describe('evaluateCandidates', () => {
  it('selects only intents whose required facts the case actually has', () => {
    const c = makeCase({ facets: extractFacets({ decision: 'Should I execute this?', transactionHash: TX }) });
    const names = evaluateCandidates(c).map((x) => x.intent);
    expect(names).toContain('ONCHAIN_TX_LOOKUP');
    // No address, asset, url or protocol in this case.
    expect(names).not.toContain('WALLET_BALANCE_CHECK');
    expect(names).not.toContain('CRYPTO_PRICE');
    expect(names).not.toContain('URL_SCAN');
  });

  it('ranks by information value per dollar, best first', () => {
    const c = makeCase({
      facets: extractFacets({ decision: `Send USDC to ${ADDR} via Aave`, transactionHash: TX }),
    });
    const ranked = evaluateCandidates(c);
    expect(ranked.length).toBeGreaterThan(2);
    for (let i = 1; i < ranked.length; i += 1) {
      expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score);
    }
  });

  it('decays novelty for an intent already bought, deprioritising a repeat', () => {
    const facets = extractFacets({ decision: `Send USDC to ${ADDR}`, transactionHash: TX });
    const fresh = makeCase({ facets });
    const repeated = makeCase({ facets, evidence: [ev('ONCHAIN_TX_LOOKUP')] });

    const before = evaluateCandidates(fresh).find((x) => x.intent === 'ONCHAIN_TX_LOOKUP')!;
    const after = evaluateCandidates(repeated).find((x) => x.intent === 'ONCHAIN_TX_LOOKUP')!;

    expect(after.novelty).toBeLessThan(before.novelty);
    expect(after.score).toBeLessThan(before.score);
  });

  it('boosts deterministic intents when the case is in material conflict', () => {
    const facets = extractFacets({ decision: `Send USDC to ${ADDR}`, transactionHash: TX });
    const calm = makeCase({ facets });
    const conflicted = makeCase({
      facets,
      assessment: {
        confidence: 0.4,
        direction: 'SUPPORT',
        supportMass: 1,
        contradictMass: 0.9,
        contradictionRatio: 0.47,
        materialConflict: true,
        agreement: 0.53,
        evidenceStrength: 0.8,
        corroboration: 0.8,
        distinctIntents: 2,
        rationale: [],
      },
      evidence: [ev('NEWS_SEARCH')],
    });

    const calmTx = evaluateCandidates(calm).find((x) => x.intent === 'ONCHAIN_TX_LOOKUP')!;
    const conflictTx = evaluateCandidates(conflicted).find((x) => x.intent === 'ONCHAIN_TX_LOOKUP')!;
    expect(conflictTx.reason).toContain('tie-breaker');
    expect(conflictTx.expectedInformationValue).toBeGreaterThan(calmTx.expectedInformationValue * 0.9);
  });

  it('produces a usable query for every candidate it returns', () => {
    const c = makeCase({
      facets: extractFacets({ decision: `Send USDC to ${ADDR} via Aave`, transactionHash: TX }),
    });
    for (const candidate of evaluateCandidates(c)) {
      expect(candidate.query.length).toBeGreaterThan(10);
    }
  });
});

describe('planRound', () => {
  it('never selects a candidate that does not fit the remaining budget', () => {
    const c = makeCase({
      facets: extractFacets({ decision: `Send USDC to ${ADDR} via Aave`, transactionHash: TX }),
      budget: { allocatedUsdc: 0.1, spentUsdc: 0.09, remainingUsdc: 0.01 },
    });
    const plan = planRound(c, getPolicy('medium'));
    // Every registry intent estimates 0.015, above the 0.01 left.
    expect(plan.selected).toHaveLength(0);
    expect(plan.skipped.length).toBeGreaterThan(0);
    expect(plan.skipped[0]!.reason).toMatch(/exceeds remaining/);
  });

  it('caps the round at the policy intent count', () => {
    const c = makeCase({
      facets: extractFacets({ decision: `Send USDC to ${ADDR} via Aave`, transactionHash: TX }),
      budget: { allocatedUsdc: 5, spentUsdc: 0, remainingUsdc: 5 },
    });
    const plan = planRound(c, getPolicy('high')); // intentsPerRound: 2
    expect(plan.selected).toHaveLength(2);
  });

  it('keeps the planned cost within the remaining budget', () => {
    const c = makeCase({
      facets: extractFacets({ decision: `Send USDC to ${ADDR} via Aave`, transactionHash: TX }),
      budget: { allocatedUsdc: 0.04, spentUsdc: 0, remainingUsdc: 0.04 },
    });
    const plan = planRound(c, getPolicy('medium'));
    expect(plan.estimatedCostUsdc).toBeLessThanOrEqual(0.04);
  });
});

describe('shouldContinueResearch', () => {
  const policy = getPolicy('medium');

  it('stops once the confidence target is met with enough corroboration', () => {
    const c = makeCase({
      roundsUsed: 1,
      evidence: [ev('ONCHAIN_TX_LOOKUP'), ev('WALLET_BALANCE_CHECK')],
      assessment: {
        confidence: 0.94,
        direction: 'SUPPORT',
        supportMass: 2,
        contradictMass: 0,
        contradictionRatio: 0,
        materialConflict: false,
        agreement: 1,
        evidenceStrength: 0.9,
        corroboration: 0.9,
        distinctIntents: 2,
        rationale: [],
      },
    });
    const r = shouldContinueResearch(c, policy);
    expect(r.proceed).toBe(false);
    expect(r.reason).toMatch(/target reached/i);
  });

  it('continues when the target is met but corroboration is too thin', () => {
    const c = makeCase({
      roundsUsed: 1,
      evidence: [ev('ONCHAIN_TX_LOOKUP')],
      assessment: {
        confidence: 0.95,
        direction: 'SUPPORT',
        supportMass: 1,
        contradictMass: 0,
        contradictionRatio: 0,
        materialConflict: false,
        agreement: 1,
        evidenceStrength: 0.9,
        corroboration: 0.57,
        distinctIntents: 1,
        rationale: [],
      },
    });
    const r = shouldContinueResearch(c, policy);
    expect(r.proceed).toBe(true);
    expect(r.reason).toMatch(/distinct intent/);
  });

  it('escalates on a material conflict even when confidence looks adequate', () => {
    const c = makeCase({
      roundsUsed: 1,
      facets: extractFacets({ decision: `Send USDC to ${ADDR}`, transactionHash: TX }),
      evidence: [ev('ONCHAIN_TX_LOOKUP'), ev('FRAUD_DETECTION', 'CONTRADICTS')],
      assessment: {
        confidence: 0.93,
        direction: 'SUPPORT',
        supportMass: 2,
        contradictMass: 0.8,
        contradictionRatio: 0.29,
        materialConflict: true,
        agreement: 0.71,
        evidenceStrength: 0.9,
        corroboration: 0.8,
        distinctIntents: 2,
        rationale: [],
      },
    });
    const r = shouldContinueResearch(c, policy);
    expect(r.proceed).toBe(true);
    expect(r.reason).toMatch(/Material conflict/i);
  });

  it('stops when the round limit is reached', () => {
    const c = makeCase({ roundsUsed: 3 });
    expect(shouldContinueResearch(c, policy).proceed).toBe(false);
  });

  it('stops when the remaining budget cannot afford the cheapest intent', () => {
    const c = makeCase({
      roundsUsed: 1,
      budget: { allocatedUsdc: 0.1, spentUsdc: 0.095, remainingUsdc: 0.005 },
    });
    const r = shouldContinueResearch(c, policy);
    expect(r.proceed).toBe(false);
    expect(r.reason).toMatch(/below the cheapest/);
  });

  it('continues while no directional evidence exists at all', () => {
    const c = makeCase({ roundsUsed: 1 });
    expect(shouldContinueResearch(c, policy).proceed).toBe(true);
  });
});

describe('acting wallet vs counterparty addresses', () => {
  const ACTING = `0x${'a'.repeat(40)}`;
  const COUNTERPARTY = `0x${'c'.repeat(40)}`;

  it('keeps the acting wallet out of the counterparty list', () => {
    const f = extractFacets({
      decision: `Send USDC from ${ACTING} to ${COUNTERPARTY}`,
      actingAddress: ACTING,
    });
    expect(f.actingAddress).toBe(ACTING);
    expect(f.addresses).toEqual([COUNTERPARTY]);
    expect(f.addresses).not.toContain(ACTING);
  });

  it('matches the acting wallet case-insensitively when filtering', () => {
    const f = extractFacets({
      decision: `Send from ${ACTING.toUpperCase().replace('0X', '0x')} to ${COUNTERPARTY}`,
      actingAddress: ACTING,
    });
    expect(f.addresses).not.toContain(ACTING);
  });

  it('never infers an acting wallet from prose', () => {
    const f = extractFacets({ decision: `Send USDC to ${COUNTERPARTY}` });
    expect(f.actingAddress).toBeUndefined();
    expect(f.addresses).toEqual([COUNTERPARTY]);
  });

  it('does not buy a balance check when no acting wallet is known', () => {
    // The live run checked the Aave pool's balance and read its 0 ETH as the
    // caller being unable to pay. Without an acting wallet the intent is now
    // simply not a candidate.
    const c = makeCase({
      facets: extractFacets({ decision: `Supply USDC to ${COUNTERPARTY} via Aave` }),
    });
    const names = evaluateCandidates(c).map((x) => x.intent);
    expect(names).not.toContain('WALLET_BALANCE_CHECK');
  });

  it('buys a balance check once an acting wallet is supplied', () => {
    const c = makeCase({
      facets: extractFacets({
        decision: `Supply USDC to ${COUNTERPARTY} via Aave`,
        actingAddress: ACTING,
      }),
    });
    const candidate = evaluateCandidates(c).find((x) => x.intent === 'WALLET_BALANCE_CHECK');
    expect(candidate).toBeDefined();
    expect(candidate!.query).toContain(ACTING);
    expect(candidate!.query).not.toContain(COUNTERPARTY);
  });

  it('names the token in the balance query so miners do not answer with native balance', () => {
    // The live miner returned symbol "ETH", token null, for a query that said
    // only "token balance".
    const c = makeCase({
      facets: extractFacets({ decision: 'Supply USDC to Aave', actingAddress: ACTING }),
    });
    const candidate = evaluateCandidates(c).find((x) => x.intent === 'WALLET_BALANCE_CHECK')!;
    expect(candidate.query).toContain('USDC token balance');
    expect(candidate.context).toMatchObject({ address: ACTING, symbol: 'USDC' });
  });

  it('still points fraud checks at the counterparty, not the acting wallet', () => {
    const c = makeCase({
      facets: extractFacets({
        decision: `Supply USDC to ${COUNTERPARTY}`,
        actingAddress: ACTING,
      }),
    });
    const candidate = evaluateCandidates(c).find((x) => x.intent === 'FRAUD_DETECTION')!;
    expect(candidate.query).toContain(COUNTERPARTY);
    expect(candidate.query).not.toContain(ACTING);
  });
});

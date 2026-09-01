import { describe, expect, it } from 'vitest';
import {
  assessConfidence,
  scoreFreshness,
  scoreRelevance,
  scoreReliability,
} from '../src/decision/confidence-engine.js';
import { getPolicy } from '../src/decision/policy-engine.js';
import type { EvidenceItem, EvidenceStance } from '../src/types/evidence.js';
import type { TelegraphAskRecord } from '../src/types/telegraph.js';

const policy = getPolicy('medium');

function record(overrides: Partial<TelegraphAskRecord> = {}): TelegraphAskRecord {
  return {
    requestId: 'req-1',
    requestedIntent: 'ONCHAIN_TX_LOOKUP',
    routedIntent: 'ONCHAIN_TX_LOOKUP',
    result: { status: 'success' },
    warnings: [],
    signalHash: '0xabc',
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

function evidence(
  stance: EvidenceStance,
  weight: number,
  intent = 'ONCHAIN_TX_LOOKUP',
): EvidenceItem {
  return {
    id: `ev-${Math.random().toString(36).slice(2)}`,
    round: 1,
    requestedIntent: intent,
    tier: 'A_DETERMINISTIC',
    status: 'COLLECTED',
    stance,
    quality: 'HIGH',
    finding: 'test',
    matchedSignals: [],
    reliability: weight,
    relevance: 1,
    freshness: 1,
    weight,
    deycidConfidence: weight,
    costUsd: 0.01,
    source: record({ requestedIntent: intent }),
    createdAt: new Date().toISOString(),
  };
}

describe('scoreReliability', () => {
  it('trusts Tier A (deterministic) above Tier B (LLM-judge)', () => {
    const tierA = scoreReliability(record({ requestedIntent: 'ONCHAIN_TX_LOOKUP' }), 'HIGH');
    const tierB = scoreReliability(record({ requestedIntent: 'NEWS_SEARCH', routedIntent: 'NEWS_SEARCH' }), 'HIGH');
    expect(tierA.reliability).toBeGreaterThan(tierB.reliability);
  });

  it('discounts evidence Telegraph routed to a different intent than requested', () => {
    const matched = scoreReliability(record(), 'HIGH');
    const mismatched = scoreReliability(record({ routedIntent: 'CHAT_COMPLETION' }), 'HIGH');
    expect(mismatched.reliability).toBeLessThan(matched.reliability);
    expect(mismatched.notes.join(' ')).toContain('routed to CHAT_COMPLETION');
  });

  it('discounts a call Telegraph did not record under a signal hash', () => {
    const withHash = scoreReliability(record(), 'HIGH');
    const withoutHash = scoreReliability(record({ signalHash: undefined }), 'HIGH');
    expect(withoutHash.reliability).toBeLessThan(withHash.reliability);
  });

  it('penalises Telegraph warnings only lightly, capped at two', () => {
    const clean = scoreReliability(record(), 'HIGH');
    const one = scoreReliability(record({ warnings: ['a'] }), 'HIGH');
    const two = scoreReliability(record({ warnings: ['a', 'b'] }), 'HIGH');
    const five = scoreReliability(record({ warnings: ['a', 'b', 'c', 'd', 'e'] }), 'HIGH');

    expect(one.reliability).toBeLessThan(clean.reliability);
    expect(two.reliability).toBeLessThan(one.reliability);
    // Capped: a fourth and fifth warning cost nothing more than the second.
    expect(five.reliability).toBeCloseTo(two.reliability, 10);

    // Telegraph documents warnings as advisory, so the total cost stays small.
    expect(five.reliability).toBeGreaterThan(clean.reliability * 0.9);
  });

  it('weights a clean structured read above a lexical one', () => {
    const high = scoreReliability(record(), 'HIGH');
    const low = scoreReliability(record(), 'LOW');
    expect(high.reliability).toBeGreaterThan(low.reliability);
  });

  it('stays within 0..1 for every combination', () => {
    const worst = scoreReliability(
      record({ requestedIntent: 'NEWS_SEARCH', routedIntent: 'X', signalHash: undefined, warnings: ['a', 'b', 'c'] }),
      'LOW',
    );
    expect(worst.reliability).toBeGreaterThanOrEqual(0);
    expect(worst.reliability).toBeLessThanOrEqual(1);
  });

  it('refuses to score an intent outside the registry', () => {
    expect(() => scoreReliability(record({ requestedIntent: 'NOT_A_REAL_INTENT' }), 'HIGH')).toThrow(
      /unregistered intent/i,
    );
  });
});

describe('scoreFreshness', () => {
  const now = Date.parse('2026-09-01T12:00:00Z');

  it('is 1 for evidence observed right now', () => {
    expect(scoreFreshness('CRYPTO_PRICE', new Date(now).toISOString(), now)).toBeCloseTo(1, 5);
  });

  it('is exactly 0.5 at one half-life', () => {
    // CRYPTO_PRICE half-life is 600s.
    const observed = new Date(now - 600_000).toISOString();
    expect(scoreFreshness('CRYPTO_PRICE', observed, now)).toBeCloseTo(0.5, 5);
  });

  it('discounts stale evidence far more for fast-moving intents', () => {
    const observed = new Date(now - 3_600_000).toISOString(); // 1 hour old
    const price = scoreFreshness('CRYPTO_PRICE', observed, now); // half-life 600s
    const tx = scoreFreshness('ONCHAIN_TX_LOOKUP', observed, now); // half-life 86400s
    expect(price).toBeLessThan(tx);
    expect(tx).toBeGreaterThan(0.9);
  });

  it('never leaves 0..1', () => {
    const ancient = new Date(now - 10 ** 12).toISOString();
    const v = scoreFreshness('CRYPTO_PRICE', ancient, now);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});

describe('scoreRelevance', () => {
  it('lifts an intent whose anchoring fact the case actually has', () => {
    const withTx = scoreRelevance('ONCHAIN_TX_LOOKUP', {
      addresses: [],
      assets: [],
      urls: [],
      subjects: [],
      transactionHash: '0x' + 'a'.repeat(64),
    });
    const withoutTx = scoreRelevance('ONCHAIN_TX_LOOKUP', {
      addresses: [],
      assets: [],
      urls: [],
      subjects: [],
    });
    expect(withTx).toBeGreaterThan(withoutTx);
  });

  it('returns 0 for an unregistered intent', () => {
    expect(scoreRelevance('NOPE', { addresses: [], assets: [], urls: [], subjects: [] })).toBe(0);
  });
});

describe('assessConfidence', () => {
  it('reports zero confidence when there is no directional evidence', () => {
    const a = assessConfidence([evidence('UNCERTAIN', 0.9), evidence('NEUTRAL', 0.9)], policy);
    expect(a.confidence).toBe(0);
    expect(a.direction).toBe('NONE');
  });

  it('rises as corroborating support accumulates across distinct intents', () => {
    const one = assessConfidence([evidence('SUPPORTS', 0.9, 'ONCHAIN_TX_LOOKUP')], policy);
    const two = assessConfidence(
      [evidence('SUPPORTS', 0.9, 'ONCHAIN_TX_LOOKUP'), evidence('SUPPORTS', 0.9, 'WALLET_BALANCE_CHECK')],
      policy,
    );
    const three = assessConfidence(
      [
        evidence('SUPPORTS', 0.9, 'ONCHAIN_TX_LOOKUP'),
        evidence('SUPPORTS', 0.9, 'WALLET_BALANCE_CHECK'),
        evidence('SUPPORTS', 0.9, 'CRYPTO_PRICE'),
      ],
      policy,
    );
    expect(two.confidence).toBeGreaterThan(one.confidence);
    expect(three.confidence).toBeGreaterThan(two.confidence);
  });

  it('drops sharply when evidence contradicts', () => {
    const unanimous = assessConfidence(
      [evidence('SUPPORTS', 0.9, 'ONCHAIN_TX_LOOKUP'), evidence('SUPPORTS', 0.9, 'WALLET_BALANCE_CHECK')],
      policy,
    );
    const conflicted = assessConfidence(
      [evidence('SUPPORTS', 0.9, 'ONCHAIN_TX_LOOKUP'), evidence('CONTRADICTS', 0.9, 'WALLET_BALANCE_CHECK')],
      policy,
    );
    expect(conflicted.confidence).toBeLessThan(unanimous.confidence);
    expect(conflicted.contradictionRatio).toBeCloseTo(0.5, 5);
  });

  it('never averages a contradiction away into high confidence', () => {
    const evenSplit = assessConfidence(
      [evidence('SUPPORTS', 0.95, 'ONCHAIN_TX_LOOKUP'), evidence('CONTRADICTS', 0.95, 'FRAUD_DETECTION')],
      policy,
    );
    expect(evenSplit.confidence).toBeLessThan(0.5);
    expect(evenSplit.materialConflict).toBe(true);
  });

  it('flags material conflict only past the policy tolerance', () => {
    // medium policy tolerates a contradiction ratio up to 0.2.
    const mild = assessConfidence(
      [
        evidence('SUPPORTS', 1.0, 'ONCHAIN_TX_LOOKUP'),
        evidence('SUPPORTS', 1.0, 'WALLET_BALANCE_CHECK'),
        evidence('SUPPORTS', 1.0, 'CRYPTO_PRICE'),
        evidence('CONTRADICTS', 0.3, 'NEWS_SEARCH'),
      ],
      policy,
    );
    expect(mild.contradictionRatio).toBeLessThan(0.2);
    expect(mild.materialConflict).toBe(false);
  });

  it('leans CONTRADICT when contradiction mass dominates', () => {
    const a = assessConfidence(
      [evidence('CONTRADICTS', 0.9, 'FRAUD_DETECTION'), evidence('CONTRADICTS', 0.9, 'URL_SCAN')],
      policy,
    );
    expect(a.direction).toBe('CONTRADICT');
    expect(a.confidence).toBeGreaterThan(0.5);
  });

  it('excludes failed evidence entirely', () => {
    const failed: EvidenceItem = { ...evidence('SUPPORTS', 0.9), status: 'FAILED' };
    const a = assessConfidence([failed], policy);
    expect(a.confidence).toBe(0);
    expect(a.direction).toBe('NONE');
  });

  it('keeps confidence bounded in 0..1 under extreme mass', () => {
    const many = Array.from({ length: 40 }, (_, i) => evidence('SUPPORTS', 1, `INTENT_${i}`));
    const a = assessConfidence(many, policy);
    expect(a.confidence).toBeGreaterThanOrEqual(0);
    expect(a.confidence).toBeLessThanOrEqual(1);
    expect(a.confidence).toBeLessThan(1); // ceiling holds
  });

  it('punishes contradiction harder under a cautious policy', () => {
    const items = [
      evidence('SUPPORTS', 0.9, 'ONCHAIN_TX_LOOKUP'),
      evidence('SUPPORTS', 0.9, 'WALLET_BALANCE_CHECK'),
      evidence('CONTRADICTS', 0.5, 'FRAUD_DETECTION'),
    ];
    const cautious = assessConfidence(items, getPolicy('low'));
    const permissive = assessConfidence(items, getPolicy('high'));
    expect(cautious.confidence).toBeLessThan(permissive.confidence);
  });

  it('always emits a rationale trace', () => {
    const a = assessConfidence([evidence('SUPPORTS', 0.9)], policy);
    expect(a.rationale.length).toBeGreaterThan(3);
    expect(a.rationale.join(' ')).toMatch(/Deycid confidence/);
  });
});

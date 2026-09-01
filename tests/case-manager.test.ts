import { beforeEach, describe, expect, it } from 'vitest';
import { CaseManager } from '../src/decision/case-manager.js';
import { buildReceipt, renderReceiptMarkdown } from '../src/decision/receipt.js';
import { setLogLevel } from '../src/utils/logger.js';
import { __resetCaseCounterForTests } from '../src/utils/ids.js';
import {
  BAD_FRAUD,
  MockTelegraphClient,
  OK_BALANCE,
  OK_FRAUD,
  OK_TX,
} from './helpers/mock-telegraph.js';
import { WalletUnavailableError, TelegraphUnavailableError } from '../src/errors.js';

const TX = `0x${'a'.repeat(64)}`;
const ADDR = `0x${'b'.repeat(40)}`;

// No confidenceThreshold: unset means each case uses its risk policy's band,
// which is what an operator who has not set DEFAULT_CONFIDENCE_THRESHOLD gets.
const DEFAULTS = { intelligenceBudgetUsdc: 0.1, maxRounds: 3 };

// Keep the acquisition loop's demo output out of the test report.
setLogLevel('error');

beforeEach(() => {
  __resetCaseCounterForTests();
});

function manager(mock: MockTelegraphClient): CaseManager {
  return new CaseManager(mock, DEFAULTS);
}

describe('createCase — input validation', () => {
  const mgr = () => manager(new MockTelegraphClient().fallback({ result: OK_TX }));

  it('rejects a decision that is too short', () => {
    expect(() => mgr().createCase({ decision: 'no' })).toThrow(/at least 8 characters/);
  });

  it('rejects a malformed transaction hash', () => {
    expect(() =>
      mgr().createCase({ decision: 'Should I execute this?', transactionHash: '0xdeadbeef' }),
    ).toThrow(/32-byte hex/);
  });

  it('applies policy defaults when nothing is specified', () => {
    const c = mgr().createCase({ decision: 'Should I execute this transaction?' });
    expect(c.policyName).toBe('MEDIUM_RISK_TOLERANCE');
    expect(c.request.confidenceThreshold).toBe(0.9);
    expect(c.state).toBe('CREATED');
  });

  it('caps a requested budget at the policy ceiling', () => {
    // high tolerance caps at $0.25.
    const c = mgr().createCase({
      decision: 'Should I execute this transaction?',
      riskTolerance: 'high',
      intelligenceBudgetUsdc: 99,
    });
    expect(c.request.intelligenceBudgetUsdc).toBe(0.25);
  });

  it('caps requested rounds at the policy ceiling', () => {
    const c = mgr().createCase({
      decision: 'Should I execute this transaction?',
      riskTolerance: 'high',
      maxRounds: 10,
    });
    expect(c.request.maxRounds).toBe(2);
  });

  it('honours an explicit confidence threshold over the policy band', () => {
    const c = mgr().createCase({
      decision: 'Should I execute this transaction?',
      riskTolerance: 'low',
      confidenceThreshold: 0.75,
    });
    expect(c.request.confidenceThreshold).toBe(0.75);
  });
});

describe('evaluate — the acquisition loop', () => {
  it('approves when corroborating evidence clears the target', async () => {
    const mock = new MockTelegraphClient()
      .on('ONCHAIN_TX_LOOKUP', { result: OK_TX })
      .on('WALLET_BALANCE_CHECK', { result: OK_BALANCE })
      .on('FRAUD_DETECTION', { result: OK_FRAUD })
      .fallback({ result: { status: 'success' } });

    const c = await manager(mock).evaluate({
      decision: `Should I execute this transaction sending USDC to ${ADDR}?`,
      transactionHash: TX,
      chain: 'base',
      riskTolerance: 'medium',
    });

    expect(c.verdict).toBe('APPROVE');
    expect(c.state).toBe('APPROVED');
    expect(c.assessment!.confidence).toBeGreaterThanOrEqual(c.request.confidenceThreshold);
    expect(c.evidence.length).toBeGreaterThan(0);
  });

  it('rejects when contradicting evidence dominates', async () => {
    const mock = new MockTelegraphClient()
      .on('ONCHAIN_TX_LOOKUP', { result: { status: 'reverted' } })
      .on('WALLET_BALANCE_CHECK', { result: { balance: 0 } })
      .on('FRAUD_DETECTION', { result: BAD_FRAUD })
      .fallback({ result: BAD_FRAUD });

    const c = await manager(mock).evaluate({
      decision: `Should I execute this transaction sending USDC to ${ADDR}?`,
      transactionHash: TX,
      riskTolerance: 'medium',
    });

    expect(c.verdict).toBe('REJECT');
    expect(c.state).toBe('REJECTED');
    expect(c.assessment!.direction).toBe('CONTRADICT');
  });

  it('abstains rather than approving when evidence stays unreadable', async () => {
    const mock = new MockTelegraphClient().fallback({ result: { irrelevant: 'payload' } });

    const c = await manager(mock).evaluate({
      decision: `Should I execute this transaction sending USDC to ${ADDR}?`,
      transactionHash: TX,
    });

    expect(c.verdict).toBe('ABSTAIN');
    expect(c.assessment!.confidence).toBe(0);
    expect(['BUDGET_EXHAUSTED', 'MAX_ROUNDS_REACHED']).toContain(c.state);
  });

  it('opens another round when the first does not reach the target', async () => {
    const mock = new MockTelegraphClient().fallback({ result: OK_TX });
    const c = await manager(mock).evaluate({
      decision: `Should I execute this transaction sending USDC to ${ADDR} via Aave?`,
      transactionHash: TX,
      riskTolerance: 'low', // target 0.95, needs 3 distinct intents
      intelligenceBudgetUsdc: 0.5,
    });
    expect(c.roundsUsed).toBeGreaterThan(1);
  });

  it('escalates on a material conflict', async () => {
    const mock = new MockTelegraphClient()
      .on('ONCHAIN_TX_LOOKUP', { result: OK_TX })
      .on('WALLET_BALANCE_CHECK', { result: OK_BALANCE })
      .on('FRAUD_DETECTION', { result: BAD_FRAUD })
      .fallback({ result: { status: 'success' } });

    const c = await manager(mock).evaluate({
      decision: `Should I execute this transaction sending USDC to ${ADDR}?`,
      transactionHash: TX,
      riskTolerance: 'low',
      intelligenceBudgetUsdc: 0.5,
    });

    const sawConflict = c.timeline.some((t) => t.note?.includes('Material conflict'));
    expect(sawConflict || c.assessment!.contradictionRatio > 0).toBe(true);
    expect(c.assessment!.contradictMass).toBeGreaterThan(0);
  });
});

describe('budget enforcement', () => {
  it('never spends more than the allocated budget', async () => {
    const mock = new MockTelegraphClient().fallback({ result: { unreadable: true }, costUsd: 0.02 });
    const c = await manager(mock).evaluate({
      decision: `Should I execute this transaction sending USDC to ${ADDR} via Aave?`,
      transactionHash: TX,
      intelligenceBudgetUsdc: 0.05,
      maxRounds: 3,
    });

    expect(c.budget.spentUsdc).toBeLessThanOrEqual(c.budget.allocatedUsdc);
    expect(c.budget.remainingUsdc).toBeGreaterThanOrEqual(0);
  });

  it('computes remaining budget as allocated minus spent', async () => {
    const mock = new MockTelegraphClient().fallback({ result: OK_TX, costUsd: 0.01 });
    const c = await manager(mock).evaluate({
      decision: `Should I execute this transaction sending USDC to ${ADDR}?`,
      transactionHash: TX,
      intelligenceBudgetUsdc: 0.1,
    });
    expect(c.budget.remainingUsdc).toBeCloseTo(c.budget.allocatedUsdc - c.budget.spentUsdc, 6);
  });

  it('stops acquiring once the budget cannot afford another call', async () => {
    const mock = new MockTelegraphClient().fallback({ result: { unreadable: true }, costUsd: 0.02 });
    const c = await manager(mock).evaluate({
      decision: `Should I execute this transaction sending USDC to ${ADDR} via Aave?`,
      transactionHash: TX,
      intelligenceBudgetUsdc: 0.03,
      maxRounds: 5,
    });

    // Budget allows at most two calls at $0.02 with a $0.015 estimate gate.
    expect(mock.calls.length).toBeLessThanOrEqual(2);
    expect(c.budget.spentUsdc).toBeLessThanOrEqual(0.04);
  });

  it('records a payment receipt for each successful purchase', async () => {
    const mock = new MockTelegraphClient().fallback({ result: OK_TX });
    const c = await manager(mock).evaluate({
      decision: `Should I execute this transaction sending USDC to ${ADDR}?`,
      transactionHash: TX,
    });
    expect(c.payments.length).toBe(c.evidence.filter((e) => e.status === 'COLLECTED').length);
    for (const p of c.payments) {
      expect(p.settled).toBe(true);
      expect(p.network).toBe('eip155:84532');
    }
  });
});

describe('failure handling', () => {
  it('records a failed acquisition without letting it add confidence', async () => {
    const mock = new MockTelegraphClient()
      .on('ONCHAIN_TX_LOOKUP', { result: null, throws: new TelegraphUnavailableError('node down') })
      .fallback({ result: OK_BALANCE });

    const c = await manager(mock).evaluate({
      decision: `Should I execute this transaction sending USDC to ${ADDR}?`,
      transactionHash: TX,
    });

    const failed = c.evidence.filter((e) => e.status === 'FAILED');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]!.weight).toBe(0);
    expect(failed[0]!.finding).toMatch(/Acquisition failed/);
  });

  it('fails the case when no wallet is available to pay', async () => {
    const mock = new MockTelegraphClient()
      .setCanPay(false)
      .fallback({ result: null, throws: new WalletUnavailableError('no key configured') });

    const c = await manager(mock).evaluate({
      decision: 'Should I execute this transaction?',
      transactionHash: TX,
    });

    expect(c.state).toBe('FAILED');
    expect(c.verdict).toBe('ABSTAIN');
    expect(c.error).toMatch(/no key configured/);
  });

  it('fails cleanly when the case carries no fact any intent can use', async () => {
    const mock = new MockTelegraphClient().fallback({ result: OK_TX });
    const c = await manager(mock).evaluate({ decision: 'Should I buy a sandwich for lunch today?' });

    expect(c.state).toBe('FAILED');
    expect(c.stopReason).toMatch(/No intent in the registry/);
    expect(mock.calls).toHaveLength(0);
  });

  it('throws CaseNotFoundError for an unknown case id', () => {
    const mgr = manager(new MockTelegraphClient().fallback({ result: OK_TX }));
    expect(() => mgr.getCase('case-nope')).toThrow(/No decision case/);
  });
});

describe('telemetry and receipts', () => {
  it('reports only what this process actually ran', async () => {
    const mock = new MockTelegraphClient().fallback({ result: OK_TX });
    const mgr = manager(mock);

    expect(mgr.getTelemetry().totalCases).toBe(0);
    expect(mgr.getTelemetry().averageConfidence).toBeNull();

    await mgr.evaluate({
      decision: `Should I execute this transaction sending USDC to ${ADDR}?`,
      transactionHash: TX,
    });

    const t = mgr.getTelemetry();
    expect(t.totalCases).toBe(1);
    expect(t.completedCases).toBe(1);
    expect(t.totalIntelligenceRequests).toBeGreaterThan(0);
    expect(t.totalSpentUsdc).toBeGreaterThan(0);
    expect(t.averageRoundsPerCase).toBeGreaterThan(0);
  });

  it('renders a receipt that labels confidence as Deycid confidence', async () => {
    const mock = new MockTelegraphClient().fallback({ result: OK_TX });
    const c = await manager(mock).evaluate({
      decision: `Should I execute this transaction sending USDC to ${ADDR}?`,
      transactionHash: TX,
    });

    const receipt = buildReceipt(c);
    const md = renderReceiptMarkdown(receipt);

    expect(md).toContain('Deycid confidence');
    expect(md).toContain('Intelligence economics');
    expect(md).toMatch(/Telegraph does not return a\s+per-response confidence score/);
    expect(receipt.caseNumber).toBe('#1042');
    expect(JSON.parse(JSON.stringify(receipt))).toBeTruthy(); // serializable
  });

  it('splits evidence into supporting, contradicting, neutral and uncertain buckets', async () => {
    const mock = new MockTelegraphClient()
      .on('ONCHAIN_TX_LOOKUP', { result: OK_TX })
      .on('FRAUD_DETECTION', { result: BAD_FRAUD })
      .fallback({ result: { nothing: 'readable' } });

    const c = await manager(mock).evaluate({
      decision: `Should I execute this transaction sending USDC to ${ADDR}?`,
      transactionHash: TX,
      riskTolerance: 'low',
      intelligenceBudgetUsdc: 0.5,
    });

    const r = buildReceipt(c);
    const total =
      r.supportingEvidence.length +
      r.contradictingEvidence.length +
      r.neutralEvidence.length +
      r.uncertainEvidence.length;
    expect(total).toBe(c.evidence.filter((e) => e.status === 'COLLECTED').length);
    expect(r.supportingEvidence.length).toBeGreaterThan(0);
    expect(r.contradictingEvidence.length).toBeGreaterThan(0);
  });

  it('escapes miner-supplied pipes so the Markdown table cannot be broken', async () => {
    const mock = new MockTelegraphClient().fallback({
      result: { status: 'success', note: 'a | b | c' },
      minerName: 'evil | miner',
    });
    const c = await manager(mock).evaluate({
      decision: `Should I execute this transaction sending USDC to ${ADDR}?`,
      transactionHash: TX,
    });
    const md = renderReceiptMarkdown(buildReceipt(c));
    expect(md).toContain('evil \\| miner');
  });
});

describe('barren rounds', () => {
  it('stops after a round that acquired nothing rather than re-asking a dead network', async () => {
    // Every ask fails with a transport error. Deycid used to keep opening
    // rounds until maxRounds, re-asking a network that was not answering.
    const mock = new MockTelegraphClient().fallback({
      result: null,
      throws: new TelegraphUnavailableError('node down'),
    });

    const c = await manager(mock).evaluate({
      decision: `Should I execute this transaction sending USDC to ${ADDR} via Aave?`,
      transactionHash: TX,
      maxRounds: 3,
      intelligenceBudgetUsdc: 0.5,
    });

    expect(c.roundsUsed).toBe(1);
    expect(c.verdict).toBe('ABSTAIN');
    expect(c.stopReason).toMatch(/no usable intelligence/i);
    expect(c.evidence.every((e) => e.status === 'FAILED')).toBe(true);
    expect(c.budget.spentUsdc).toBe(0);
  });

  it('keeps going when a round collected at least one usable item', async () => {
    const mock = new MockTelegraphClient()
      .on('ONCHAIN_TX_LOOKUP', { result: null, throws: new TelegraphUnavailableError('flaky') })
      .fallback({ result: OK_TX });

    const c = await manager(mock).evaluate({
      decision: `Should I execute this transaction sending USDC to ${ADDR} via Aave?`,
      transactionHash: TX,
      intelligenceBudgetUsdc: 0.5,
    });

    expect(c.evidence.some((e) => e.status === 'COLLECTED')).toBe(true);
    expect(c.stopReason).not.toMatch(/no usable intelligence/i);
  });
});

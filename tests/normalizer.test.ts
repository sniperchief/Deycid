import { describe, expect, it } from 'vitest';
import { normalizeResult } from '../src/telegraph/normalizer.js';

describe('normalizeResult — structured markers (HIGH)', () => {
  it('reads a negative boolean flag as CONTRADICTS', () => {
    const n = normalizeResult({ malicious: true });
    expect(n.stance).toBe('CONTRADICTS');
    expect(n.quality).toBe('HIGH');
    expect(n.matchedSignals).toContain('malicious=true');
  });

  it('reads a cleared negative flag as SUPPORTS', () => {
    const n = normalizeResult({ is_phishing: false });
    expect(n.stance).toBe('SUPPORTS');
    expect(n.quality).toBe('HIGH');
  });

  it('reads a high risk score as CONTRADICTS', () => {
    const n = normalizeResult({ risk_score: 0.91 });
    expect(n.stance).toBe('CONTRADICTS');
    expect(n.quality).toBe('HIGH');
  });

  it('normalises a 0..100 risk scale', () => {
    expect(normalizeResult({ risk_score: 88 }).stance).toBe('CONTRADICTS');
    expect(normalizeResult({ risk_score: 4 }).stance).toBe('SUPPORTS');
  });

  it('treats a positive balance as supporting', () => {
    const n = normalizeResult({ balance: 125.4, symbol: 'USDC' });
    expect(n.stance).toBe('SUPPORTS');
  });

  it('treats a zero balance as contradicting', () => {
    expect(normalizeResult({ balance: 0 }).stance).toBe('CONTRADICTS');
  });

  it('finds markers nested inside the payload', () => {
    const n = normalizeResult({ data: { analysis: { fraud_score: 0.95 } } });
    expect(n.stance).toBe('CONTRADICTS');
    expect(n.matchedSignals[0]).toContain('data.analysis.fraud_score');
  });

  it('reads markers out of arrays', () => {
    const n = normalizeResult({ findings: [{ malicious: true }] });
    expect(n.stance).toBe('CONTRADICTS');
  });
});

describe('normalizeResult — status strings (MEDIUM)', () => {
  it('reads a success status as SUPPORTS', () => {
    const n = normalizeResult({ status: 'success', hash: '0xabc' });
    expect(n.stance).toBe('SUPPORTS');
    expect(n.quality).toBe('MEDIUM');
  });

  it('reads a reverted status as CONTRADICTS', () => {
    const n = normalizeResult({ status: 'reverted' });
    expect(n.stance).toBe('CONTRADICTS');
    expect(n.quality).toBe('MEDIUM');
  });

  it('normalises whitespace in status words', () => {
    expect(normalizeResult({ status: 'high risk' }).stance).toBe('CONTRADICTS');
  });

  it('does not reach the status pass when a structured marker already fired', () => {
    // malicious=true is HIGH and must win over the reassuring status string.
    const n = normalizeResult({ malicious: true, status: 'success' });
    expect(n.stance).toBe('CONTRADICTS');
    expect(n.quality).toBe('HIGH');
  });
});

describe('normalizeResult — lexical polarity (LOW)', () => {
  it('reads an incident report as CONTRADICTS', () => {
    const n = normalizeResult({ summary: 'The protocol was hacked last week and funds were drained.' });
    expect(n.stance).toBe('CONTRADICTS');
    expect(n.quality).toBe('LOW');
  });

  it('reads an all-clear as SUPPORTS', () => {
    const n = normalizeResult({ summary: 'No known incidents. The contract is audited and secure.' });
    expect(n.stance).toBe('SUPPORTS');
    expect(n.quality).toBe('LOW');
  });
});

describe('normalizeResult — unreadable output', () => {
  it('returns UNCERTAIN, not NEUTRAL, when nothing can be read', () => {
    const n = normalizeResult({ foo: 'bar', count: 3 });
    expect(n.stance).toBe('UNCERTAIN');
    expect(n.matchedSignals).toEqual([]);
  });

  it('returns UNCERTAIN for a null result', () => {
    expect(normalizeResult(null).stance).toBe('UNCERTAIN');
    expect(normalizeResult(undefined).stance).toBe('UNCERTAIN');
  });

  it('mentions Telegraph warnings in the finding without changing the stance', () => {
    const withWarn = normalizeResult({ status: 'success' }, ['rate limit approaching']);
    const without = normalizeResult({ status: 'success' }, []);
    expect(withWarn.stance).toBe(without.stance);
    expect(withWarn.finding).toContain('1 Telegraph warning');
  });

  it('survives a deeply nested or oversized payload without throwing', () => {
    let deep: unknown = { malicious: true };
    for (let i = 0; i < 50; i += 1) deep = { nested: deep };
    expect(() => normalizeResult(deep)).not.toThrow();

    const wide = { items: Array.from({ length: 5000 }, (_, i) => ({ i })) };
    expect(() => normalizeResult(wide)).not.toThrow();
  });
});

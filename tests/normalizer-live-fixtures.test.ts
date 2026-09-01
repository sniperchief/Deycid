import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeResult } from '../src/telegraph/normalizer.js';

/**
 * Regression tests against REAL Telegraph miner responses.
 *
 * Every payload in `fixtures/live-miner-responses.json` was returned by an
 * actual miner during a paid run on 2026-09-01, retrieved afterwards from
 * `GET /engine/v1/signal/{hash}`. Nothing here is invented or hand-written.
 *
 * These lock in the reading Deycid *should* produce. They exist because the
 * first live run produced three wrong readings, and the only way to be sure a
 * fix works — and that fixing one does not break another — is to pin the real
 * data.
 */

interface Fixture {
  intent: string;
  minerSlug: string;
  request: string;
  response: unknown;
}

const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/live-miner-responses.json', import.meta.url)), 'utf8'),
) as Record<string, Fixture>;

const get = (name: string): Fixture => {
  const f = fixtures[name];
  if (!f) throw new Error(`missing fixture ${name}`);
  return f;
};

describe('live miner responses — correct readings', () => {
  it('CRYPTO_PRICE: a real price reads as SUPPORTS (must not regress)', () => {
    const f = get('crypto-price');
    const n = normalizeResult(f.response, [], f.request);
    expect(n.stance).toBe('SUPPORTS');
    expect(n.quality).toBe('HIGH');
  });

  it('WALLET_BALANCE_CHECK: a zero balance reads as CONTRADICTS (must not regress)', () => {
    const f = get('wallet-balance-check');
    const n = normalizeResult(f.response, [], f.request);
    expect(n.stance).toBe('CONTRADICTS');
    expect(n.quality).toBe('HIGH');
  });

  it('TVL_LOOKUP: $17.9bn in tvl_usd reads as SUPPORTS, not UNCERTAIN', () => {
    // The miner answered perfectly (tvl_usd: 17929107889). Deycid missed it
    // because its key matcher required an exact `tvl` and would not accept the
    // conventional `_usd` unit suffix.
    const f = get('tvl-lookup');
    const n = normalizeResult(f.response, [], f.request);
    expect(n.stance).toBe('SUPPORTS');
    expect(n.matchedSignals.join(' ')).toContain('tvl_usd');
  });

  it('FRAUD_DETECTION: an explicit all-clear reads as SUPPORTS, not CONTRADICTS', () => {
    // "No publicly documented evidence links the address ... to known scams,
    // token drains, phishing operations, or blacklist entries."
    // Deycid read scam/phishing/malicious/fraud and called it CONTRADICTS.
    const f = get('fraud-detection');
    const n = normalizeResult(f.response, [], f.request);
    expect(n.stance).toBe('SUPPORTS');
  });

  it('NEWS_SEARCH: unrelated results with a null answer read as UNCERTAIN', () => {
    // The miner returned answer:null and a results[] array of unrelated
    // security news (a JFrog Artifactory CVE). Deycid scanned the echoed query
    // and those results, matching hack/exploit/breach, and called it
    // CONTRADICTS — a fabricated signal about Aave from text not about Aave.
    const f = get('news-search');
    const n = normalizeResult(f.response, [], f.request);
    expect(n.stance).toBe('UNCERTAIN');
  });

  it('GAS_PRICE: pipeline metadata must not be read as support', () => {
    // Deycid scored this SUPPORTS off provenance_events[0].status="SUCCESS"
    // and research_state.capability_attempts[0].status="COMPLETED" — internal
    // pipeline bookkeeping, not a claim about the decision. (The miner also
    // answered about Ethereum when asked about Base.)
    const f = get('gas-price');
    const n = normalizeResult(f.response, [], f.request);
    expect(n.stance).toBe('UNCERTAIN');
    expect(n.matchedSignals.join(' ')).not.toContain('provenance');
    expect(n.matchedSignals.join(' ')).not.toContain('research_state');
  });
});

describe('values stated in prose', () => {
  // Telegraph routes probabilistically, so the same intent comes back in
  // different shapes on different calls. A second live run sent CRYPTO_PRICE to
  // kriterion-pramagraph, which states the figure in prose
  // ("USDC (USDC): $0.9998 USD.") with no structured `price` key at all —
  // where the first run's miner returned `price: 0.9999`. Both must read.
  it('CRYPTO_PRICE stated only in prose still reads as SUPPORTS', () => {
    const f = get('crypto-price-prose');
    const n = normalizeResult(f.response, [], f.request);
    expect(n.stance).toBe('SUPPORTS');
    expect(n.matchedSignals.join(' ')).toMatch(/0\.9998/);
  });

  it('reads a scaled figure', () => {
    expect(normalizeResult({ summary: 'Total value locked is $17.93 billion.' }).stance).toBe('SUPPORTS');
  });

  it('reads a zero figure as contradicting', () => {
    expect(normalizeResult({ summary: 'The wallet holds $0.00 of the asset.' }).stance).toBe('CONTRADICTS');
  });

  it('does not invent a figure from a non-currency number', () => {
    // The gas miner answers "0.222798271 gwei" — a real number, no currency.
    expect(normalizeResult({ answer: 'Ethereum gas price: 0.222798271 gwei.' }).stance).toBe('UNCERTAIN');
  });
});

describe('negation handling', () => {
  const cases: [string, string, 'SUPPORTS' | 'CONTRADICTS'][] = [
    ['plain all-clear', 'No evidence of any hack or exploit was found.', 'SUPPORTS'],
    ['not-flagged', 'The address is not flagged as malicious or associated with phishing.', 'SUPPORTS'],
    ['absence phrasing', 'There is an absence of any scam or fraud report for this protocol.', 'SUPPORTS'],
    ['free of', 'The contract is free of known vulnerabilities.', 'SUPPORTS'],
    ['genuine incident', 'The protocol was hacked and user funds were drained.', 'CONTRADICTS'],
    ['genuine exploit', 'An exploit of the lending pool drained 4M USDC last week.', 'CONTRADICTS'],
  ];

  for (const [label, text, expected] of cases) {
    it(`${label} -> ${expected}`, () => {
      expect(normalizeResult({ summary: text }).stance).toBe(expected);
    });
  }
});

describe('scanned-text scoping', () => {
  it('ignores the echoed request when reading a conclusion', () => {
    const request = 'Report any hack, exploit, depeg or insolvency for this protocol.';
    const n = normalizeResult({ query: request, summary: 'Everything is operating normally.' }, [], request);
    expect(n.stance).toBe('SUPPORTS');
  });

  it('does not read search-result bodies as the miner\'s conclusion', () => {
    const n = normalizeResult({
      answer: null,
      results: [{ content: 'A critical vulnerability was exploited in an unrelated product.' }],
    });
    expect(n.stance).toBe('UNCERTAIN');
  });
});

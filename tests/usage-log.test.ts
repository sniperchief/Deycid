import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveUsageLogPath, UsageLog, type UsageEntry } from '../src/usage/log.js';
import { signalExplorerUrl, transactionExplorerUrl } from '../src/decision/receipt.js';

const dirs: string[] = [];
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'deycid-usage-'));
  dirs.push(d);
  return d;
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const entry = (over: Partial<UsageEntry> = {}): UsageEntry => ({
  at: new Date().toISOString(),
  caseId: 'case-1042',
  wallet: '0x3fc9c40B042Bc93D45348bfCa60f60D95D4155B3',
  requestedIntent: 'CRYPTO_PRICE',
  amountUsdc: 0.01,
  network: 'eip155:84532',
  signalHash: `0x${'a'.repeat(64)}`,
  ...over,
});

describe('resolveUsageLogPath', () => {
  it('defaults to a path under the home directory', () => {
    const p = resolveUsageLogPath({});
    expect(p).toBeTruthy();
    expect(p!.endsWith(join('.deycid', 'usage.jsonl'))).toBe(true);
  });

  it('honours an explicit path', () => {
    expect(resolveUsageLogPath({ DEYCID_USAGE_LOG: '/tmp/x.jsonl' })).toBe('/tmp/x.jsonl');
  });

  it('can be switched off', () => {
    for (const v of ['off', 'OFF', 'false', '0', 'no', 'disabled']) {
      expect(resolveUsageLogPath({ DEYCID_USAGE_LOG: v })).toBeUndefined();
    }
  });
});

describe('UsageLog', () => {
  it('records nothing at all when disabled', () => {
    const log = new UsageLog(undefined);
    expect(log.enabled).toBe(false);
    log.record(entry());
    const s = log.summarise();
    expect(s.enabled).toBe(false);
    expect(s.totalCalls).toBe(0);
  });

  it('appends entries and summarises them', () => {
    const path = join(scratch(), 'nested', 'usage.jsonl');
    const log = new UsageLog(path); // directory does not exist yet
    log.record(entry({ requestedIntent: 'CRYPTO_PRICE', amountUsdc: 0.01 }));
    log.record(entry({ requestedIntent: 'TVL_LOOKUP', amountUsdc: 0.015 }));
    log.record(entry({ requestedIntent: 'CRYPTO_PRICE', amountUsdc: 0.01, caseId: 'case-1043' }));

    const s = log.summarise();
    expect(s.enabled).toBe(true);
    expect(s.totalCalls).toBe(3);
    expect(s.totalSpentUsdc).toBeCloseTo(0.035, 6);
    expect(s.distinctCases).toBe(2);
    expect(s.byIntent).toEqual({ CRYPTO_PRICE: 2, TVL_LOOKUP: 1 });
    expect(s.wallets).toEqual(['0x3fc9c40B042Bc93D45348bfCa60f60D95D4155B3']);
    expect(s.signalHashes).toHaveLength(3);
  });

  it('treats a log that does not exist yet as empty, not an error', () => {
    const s = new UsageLog(join(scratch(), 'never-written.jsonl')).summarise();
    expect(s.enabled).toBe(true);
    expect(s.totalCalls).toBe(0);
    expect(s.error).toBeUndefined();
  });

  it('skips malformed lines rather than failing', () => {
    const path = join(scratch(), 'usage.jsonl');
    writeFileSync(path, ['{not json', '', JSON.stringify(entry()), '{"at":"x"}'].join('\n'));
    const s = new UsageLog(path).summarise();
    expect(s.totalCalls).toBe(1); // the one valid, complete row
  });

  it('never throws when the path cannot be written', () => {
    // A directory where a file is expected: append must fail internally.
    const dir = scratch();
    const log = new UsageLog(dir);
    expect(() => log.record(entry())).not.toThrow();
    expect(() => log.record(entry())).not.toThrow(); // still quiet after warning once
  });

  it('writes one JSON object per line', () => {
    const path = join(scratch(), 'usage.jsonl');
    const log = new UsageLog(path);
    log.record(entry());
    log.record(entry());
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });
});

describe('explorer links', () => {
  it('builds a Telegraph signal URL on the singular path', () => {
    // /signals/{hash} is a 404; /signal/{hash} is the real page.
    const url = signalExplorerUrl('0xabc');
    expect(url).toBe('https://explorer.telegraphprotocol.com/signal/0xabc');
    expect(url).not.toContain('/signals/');
  });

  it('maps known networks to a chain explorer', () => {
    expect(transactionExplorerUrl('eip155:84532', '0xdead')).toBe('https://sepolia.basescan.org/tx/0xdead');
    expect(transactionExplorerUrl('eip155:8453', '0xdead')).toBe('https://basescan.org/tx/0xdead');
  });

  it('returns undefined for a network it does not know, rather than guessing', () => {
    expect(transactionExplorerUrl('solana:xyz', '0xdead')).toBeUndefined();
  });
});

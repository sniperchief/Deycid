import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';

/**
 * Local usage log.
 *
 * Telegraph records every paid call as a Signal keyed by the *paying wallet*,
 * and offers no public way to list signals for a wallet — the explorer searches
 * by hash, miner or intent only. So an application distributed as a self-hosted
 * MCP server, where every operator pays from their own wallet, cannot see its
 * own aggregate usage. Telegraph's guidance for that is to collect it yourself.
 *
 * This is that collection, and nothing more:
 *
 *   - It is written to a **local file only**. Deycid never transmits it
 *     anywhere. Sharing a report is always a deliberate act by the operator.
 *   - It records only what the operator's own wallet already published to
 *     Telegraph by making the call — nothing private is added.
 *   - Every line is independently checkable: the signal hash resolves on
 *     Telegraph's public explorer, so a report proves itself rather than asking
 *     anyone to trust it.
 *   - `DEYCID_USAGE_LOG=off` disables it entirely.
 *
 * Deliberately a plain append-only JSONL file rather than a database. A failed
 * write is never allowed to disturb a decision.
 */

export interface UsageEntry {
  at: string;
  caseId: string;
  /** The wallet that paid, as recorded on the Telegraph Signal. */
  wallet: string;
  requestedIntent: string;
  routedIntent?: string;
  minerName?: string;
  /** Telegraph's Signal hash — the verifiable part. */
  signalHash?: string;
  amountUsdc: number;
  network: string;
}

export interface UsageSummary {
  enabled: boolean;
  path?: string;
  totalCalls: number;
  totalSpentUsdc: number;
  distinctCases: number;
  wallets: string[];
  byIntent: Record<string, number>;
  firstAt?: string;
  lastAt?: string;
  /** Signal hashes, newest last, for verification. */
  signalHashes: string[];
  /** Present when the log could not be read. */
  error?: string;
}

const OFF_VALUES = new Set(['off', 'false', '0', 'no', 'disabled']);

/** Resolves the log path, or `undefined` when logging is switched off. */
export function resolveUsageLogPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = (env.DEYCID_USAGE_LOG ?? '').trim();
  if (OFF_VALUES.has(raw.toLowerCase())) return undefined;
  if (raw !== '') return raw;
  return join(homedir(), '.deycid', 'usage.jsonl');
}

export class UsageLog {
  readonly #path: string | undefined;
  #warned = false;

  constructor(path: string | undefined) {
    this.#path = path;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): UsageLog {
    return new UsageLog(resolveUsageLogPath(env));
  }

  get enabled(): boolean {
    return this.#path !== undefined;
  }

  get path(): string | undefined {
    return this.#path;
  }

  /**
   * Appends one settled call.
   * Never throws: a decision must not fail because a log file could not be
   * written. The first failure is reported once, then stays quiet.
   */
  record(entry: UsageEntry): void {
    if (!this.#path) return;
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      appendFileSync(this.#path, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (err) {
      if (!this.#warned) {
        this.#warned = true;
        logger.warn('research.stopped', {
          note: 'Usage log could not be written; decisions are unaffected.',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Reads the log back and summarises it. Malformed lines are skipped. */
  summarise(): UsageSummary {
    if (!this.#path) {
      return {
        enabled: false,
        totalCalls: 0,
        totalSpentUsdc: 0,
        distinctCases: 0,
        wallets: [],
        byIntent: {},
        signalHashes: [],
      };
    }

    let contents = '';
    try {
      contents = readFileSync(this.#path, 'utf8');
    } catch (err) {
      const notFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
      return {
        enabled: true,
        path: this.#path,
        totalCalls: 0,
        totalSpentUsdc: 0,
        distinctCases: 0,
        wallets: [],
        byIntent: {},
        signalHashes: [],
        // A log that does not exist yet is not an error, just an empty history.
        ...(notFound ? {} : { error: err instanceof Error ? err.message : String(err) }),
      };
    }

    const cases = new Set<string>();
    const wallets = new Set<string>();
    const byIntent: Record<string, number> = {};
    const signalHashes: string[] = [];
    let totalCalls = 0;
    let totalSpentUsdc = 0;
    let firstAt: string | undefined;
    let lastAt: string | undefined;

    for (const line of contents.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      let e: UsageEntry;
      try {
        e = JSON.parse(line) as UsageEntry;
      } catch {
        continue;
      }
      if (typeof e.at !== 'string' || typeof e.requestedIntent !== 'string') continue;

      totalCalls += 1;
      totalSpentUsdc += Number.isFinite(e.amountUsdc) ? e.amountUsdc : 0;
      if (e.caseId) cases.add(e.caseId);
      if (e.wallet) wallets.add(e.wallet);
      byIntent[e.requestedIntent] = (byIntent[e.requestedIntent] ?? 0) + 1;
      if (e.signalHash) signalHashes.push(e.signalHash);
      firstAt ??= e.at;
      lastAt = e.at;
    }

    return {
      enabled: true,
      path: this.#path,
      totalCalls,
      totalSpentUsdc: Number(totalSpentUsdc.toFixed(6)),
      distinctCases: cases.size,
      wallets: [...wallets],
      byIntent,
      signalHashes,
      ...(firstAt ? { firstAt } : {}),
      ...(lastAt ? { lastAt } : {}),
    };
  }
}

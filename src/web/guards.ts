/**
 * Spend and abuse guards for the public demo.
 *
 * The demo pays for strangers' intelligence out of one wallet, so the guards
 * here are the only thing between a shared link and a drained balance. They are
 * deliberately simple, in-memory and independent of the decision engine's own
 * per-case budget — three separate brakes, none of which trusts the others:
 *
 *   1. per-request budget   — how much one demo run may spend
 *   2. per-visitor rate cap — how many runs one visitor gets per hour
 *   3. daily ledger         — a hard ceiling across everyone, per UTC day
 *
 * State resets when the process restarts. For a demo that is the right
 * trade-off: a restart-proof ledger would mean a database, and the wallet
 * balance itself is the real backstop.
 */

export interface WebLimits {
  /** Hard ceiling on what a single demo run may spend, in USDC. */
  perRequestUsdc: number;
  /** Ceiling across all visitors for one UTC day, in USDC. */
  dailyUsdc: number;
  /** Runs allowed per visitor per rolling hour. */
  perVisitorPerHour: number;
}

export const DEFAULT_WEB_LIMITS: WebLimits = {
  // Enough for two rounds. A single-round demo can only ever show one shot at
  // the evidence; the escalation step — "not enough, opening another round" —
  // is Deycid's signature behaviour and worth the extra couple of cents.
  perRequestUsdc: 0.08,
  dailyUsdc: 2.0,
  perVisitorPerHour: 3,
};

export type DenialReason = 'RATE_LIMITED' | 'DAILY_BUDGET_EXHAUSTED';

export interface Decision {
  allowed: boolean;
  reason?: DenialReason;
  message?: string;
  /** Seconds until this visitor may try again. Present on RATE_LIMITED. */
  retryAfterSeconds?: number;
}

const HOUR_MS = 3_600_000;

/** UTC day key, so the ledger rolls over predictably wherever it is hosted. */
export function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class WebGuards {
  readonly #limits: WebLimits;
  /** visitor -> timestamps of recent runs */
  readonly #visits = new Map<string, number[]>();
  #day: string;
  #spentToday = 0;

  constructor(limits: WebLimits = DEFAULT_WEB_LIMITS, now: number = Date.now()) {
    this.#limits = limits;
    this.#day = dayKey(now);
  }

  get limits(): WebLimits {
    return this.#limits;
  }

  /** Rolls the ledger over when the UTC day changes. */
  #rollDay(now: number): void {
    const today = dayKey(now);
    if (today !== this.#day) {
      this.#day = today;
      this.#spentToday = 0;
    }
  }

  spentToday(now: number = Date.now()): number {
    this.#rollDay(now);
    return Number(this.#spentToday.toFixed(6));
  }

  remainingToday(now: number = Date.now()): number {
    return Number(Math.max(0, this.#limits.dailyUsdc - this.spentToday(now)).toFixed(6));
  }

  /**
   * Decides whether a visitor may start a run.
   *
   * Checks the daily ledger first: when the demo is out of money for the day,
   * every visitor gets the same clear answer rather than a rate-limit message
   * that misdescribes why they were refused.
   */
  check(visitor: string, now: number = Date.now()): Decision {
    this.#rollDay(now);

    if (this.remainingToday(now) < this.#limits.perRequestUsdc) {
      return {
        allowed: false,
        reason: 'DAILY_BUDGET_EXHAUSTED',
        message:
          'The public demo has spent its budget for today. It resets at 00:00 UTC — ' +
          'or run Deycid yourself with your own wallet.',
      };
    }

    const recent = (this.#visits.get(visitor) ?? []).filter((t) => now - t < HOUR_MS);
    if (recent.length >= this.#limits.perVisitorPerHour) {
      const oldest = recent[0]!;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + HOUR_MS - now) / 1000));
      return {
        allowed: false,
        reason: 'RATE_LIMITED',
        message:
          `The demo allows ${this.#limits.perVisitorPerHour} runs an hour per visitor, ` +
          'because each one spends real USDC. Try again later, or self-host with your own wallet.',
        retryAfterSeconds,
      };
    }

    return { allowed: true };
  }

  /** Records that a visitor started a run. Call only after `check` allowed it. */
  recordStart(visitor: string, now: number = Date.now()): void {
    this.#rollDay(now);
    const recent = (this.#visits.get(visitor) ?? []).filter((t) => now - t < HOUR_MS);
    recent.push(now);
    this.#visits.set(visitor, recent);
  }

  /** Records actual spend once a run completes. */
  recordSpend(amountUsdc: number, now: number = Date.now()): void {
    this.#rollDay(now);
    if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) return;
    this.#spentToday = Number((this.#spentToday + amountUsdc).toFixed(6));
  }

  /** Drops visitor history that has aged out, so the map cannot grow forever. */
  prune(now: number = Date.now()): void {
    for (const [visitor, times] of this.#visits) {
      const recent = times.filter((t) => now - t < HOUR_MS);
      if (recent.length === 0) this.#visits.delete(visitor);
      else this.#visits.set(visitor, recent);
    }
  }
}

/**
 * Identifies a visitor for rate limiting.
 *
 * Behind a platform proxy the socket address is the proxy, so the first hop in
 * `x-forwarded-for` is used when present. This is a courtesy limit, not a
 * security boundary — it is trivially bypassed, which is why the daily ledger
 * and the wallet balance sit behind it.
 */
export function visitorKey(headers: Record<string, string | string[] | undefined>, socketAddress?: string): string {
  const forwarded = headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = raw?.split(',')[0]?.trim();
  return first && first !== '' ? first : (socketAddress ?? 'unknown');
}

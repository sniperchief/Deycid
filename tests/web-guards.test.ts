import { describe, expect, it } from 'vitest';
import { dayKey, visitorKey, WebGuards, type WebLimits } from '../src/web/guards.js';

/**
 * These guard the demo wallet against strangers. A hole here costs real money,
 * so every limit is tested at its boundary rather than loosely.
 */

const limits: WebLimits = { perRequestUsdc: 0.05, dailyUsdc: 0.2, perVisitorPerHour: 2 };
const T0 = Date.parse('2026-09-02T10:00:00Z');
const MIN = 60_000;

describe('rate limiting', () => {
  it('allows up to the per-visitor cap, then refuses', () => {
    const g = new WebGuards(limits, T0);
    expect(g.check('a', T0).allowed).toBe(true);
    g.recordStart('a', T0);
    expect(g.check('a', T0).allowed).toBe(true);
    g.recordStart('a', T0);

    const third = g.check('a', T0);
    expect(third.allowed).toBe(false);
    expect(third.reason).toBe('RATE_LIMITED');
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('limits each visitor independently', () => {
    const g = new WebGuards(limits, T0);
    g.recordStart('a', T0);
    g.recordStart('a', T0);
    expect(g.check('a', T0).allowed).toBe(false);
    expect(g.check('b', T0).allowed).toBe(true);
  });

  it('frees a slot once the hour has rolled past', () => {
    const g = new WebGuards(limits, T0);
    g.recordStart('a', T0);
    g.recordStart('a', T0 + MIN);
    expect(g.check('a', T0 + 2 * MIN).allowed).toBe(false);
    // 61 minutes after the first run, only the second is still inside the window.
    expect(g.check('a', T0 + 61 * MIN).allowed).toBe(true);
  });

  it('prunes visitors whose history has aged out', () => {
    const g = new WebGuards(limits, T0);
    g.recordStart('a', T0);
    g.prune(T0 + 61 * MIN);
    expect(g.check('a', T0 + 61 * MIN).allowed).toBe(true);
  });
});

describe('daily budget', () => {
  it('refuses once too little is left to cover another run', () => {
    const g = new WebGuards(limits, T0);
    g.recordSpend(0.16, T0); // 0.04 left, below the 0.05 per-run cap
    const d = g.check('someone-new', T0);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('DAILY_BUDGET_EXHAUSTED');
  });

  it('still allows a run when exactly the per-run cap remains', () => {
    const g = new WebGuards(limits, T0);
    g.recordSpend(0.15, T0); // exactly 0.05 left
    expect(g.check('someone-new', T0).allowed).toBe(true);
  });

  it('reports the daily budget before rate limiting, so the reason is accurate', () => {
    const g = new WebGuards(limits, T0);
    g.recordStart('a', T0);
    g.recordStart('a', T0); // this visitor is also rate limited
    g.recordSpend(0.2, T0); // and the day is spent
    expect(g.check('a', T0).reason).toBe('DAILY_BUDGET_EXHAUSTED');
  });

  it('rolls over at the UTC day boundary', () => {
    const g = new WebGuards(limits, T0);
    g.recordSpend(0.2, T0);
    expect(g.check('a', T0).allowed).toBe(false);

    const nextDay = Date.parse('2026-09-03T00:00:01Z');
    expect(g.spentToday(nextDay)).toBe(0);
    expect(g.check('a', nextDay).allowed).toBe(true);
  });

  it('tracks spend and remaining accurately', () => {
    const g = new WebGuards(limits, T0);
    g.recordSpend(0.03, T0);
    g.recordSpend(0.02, T0);
    expect(g.spentToday(T0)).toBeCloseTo(0.05, 6);
    expect(g.remainingToday(T0)).toBeCloseTo(0.15, 6);
  });

  it('ignores nonsensical spend values', () => {
    const g = new WebGuards(limits, T0);
    g.recordSpend(-1, T0);
    g.recordSpend(Number.NaN, T0);
    g.recordSpend(0, T0);
    expect(g.spentToday(T0)).toBe(0);
  });

  it('never reports negative remaining budget', () => {
    const g = new WebGuards(limits, T0);
    g.recordSpend(99, T0);
    expect(g.remainingToday(T0)).toBe(0);
  });
});

describe('visitorKey', () => {
  it('prefers the first hop of x-forwarded-for behind a proxy', () => {
    expect(visitorKey({ 'x-forwarded-for': '203.0.113.5, 70.41.3.18' }, '10.0.0.1')).toBe('203.0.113.5');
  });

  it('handles a header delivered as an array', () => {
    expect(visitorKey({ 'x-forwarded-for': ['203.0.113.9'] }, '10.0.0.1')).toBe('203.0.113.9');
  });

  it('falls back to the socket address', () => {
    expect(visitorKey({}, '198.51.100.2')).toBe('198.51.100.2');
  });

  it('never returns empty, so limits always apply to something', () => {
    expect(visitorKey({ 'x-forwarded-for': '' }, undefined)).toBe('unknown');
  });
});

describe('dayKey', () => {
  it('is a UTC date, independent of host timezone', () => {
    expect(dayKey(Date.parse('2026-09-02T23:59:59Z'))).toBe('2026-09-02');
    expect(dayKey(Date.parse('2026-09-03T00:00:00Z'))).toBe('2026-09-03');
  });
});

/**
 * Structured logger.
 *
 * Writes NDJSON to **stderr** only. stdout is the MCP stdio transport and must
 * carry nothing but JSON-RPC frames, so a stray log line there would corrupt
 * the session.
 *
 * Every payload passes through `redactSecrets` before it is written. That is a
 * belt-and-braces measure: no call site is supposed to hand key material to the
 * logger in the first place.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

let activeLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  activeLevel = level;
}

/** Keys whose values are never printed, matched case-insensitively as substrings. */
const SECRET_KEY_PATTERN =
  /(private[_-]?key|privatekey|secret|mnemonic|seed[_-]?phrase|password|passphrase|authorization|api[_-]?key)/i;

/** A 0x-prefixed 64-hex-char run — the shape of a raw private key. */
const RAW_KEY_PATTERN = /\b0x[0-9a-fA-F]{64}\b/g;

/**
 * Recursively strips anything that looks like key material.
 *
 * Note the 32-byte-hex rule also matches transaction and signal hashes, which
 * are not secret. Those are carried on typed fields (`transaction`,
 * `signalHash`) that the logger is given explicitly, so redaction here only
 * ever hits hex that turned up loose inside free text.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') return value.replace(RAW_KEY_PATTERN, '0x[redacted]');
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactSecrets(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_PATTERN.test(k) ? '[redacted]' : redactSecrets(v, depth + 1);
  }
  return out;
}

function write(level: LogLevel, event: string, data: Record<string, unknown>): void {
  if (LEVEL_RANK[level] > LEVEL_RANK[activeLevel]) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...(redactSecrets(data) as Record<string, unknown>),
  });
  console.error(line);
}

/**
 * Named protocol events. Keeping these in one union means a live demo log is
 * greppable and no call site can invent an event name by typo.
 */
export type DeycidEvent =
  | 'case.created'
  | 'intelligence.requested'
  | 'intelligence.received'
  | 'intelligence.failed'
  | 'payment.required'
  | 'payment.completed'
  | 'payment.failed'
  | 'evidence.added'
  | 'contradiction.detected'
  | 'confidence.updated'
  | 'research.escalated'
  | 'research.stopped'
  | 'decision.completed'
  | 'decision.failed'
  | 'server.started'
  | 'config.loaded';

export const logger = {
  error: (event: DeycidEvent, data: Record<string, unknown> = {}) => write('error', event, data),
  warn: (event: DeycidEvent, data: Record<string, unknown> = {}) => write('warn', event, data),
  info: (event: DeycidEvent, data: Record<string, unknown> = {}) => write('info', event, data),
  debug: (event: DeycidEvent, data: Record<string, unknown> = {}) => write('debug', event, data),
};

/**
 * Human-readable demo line, also on stderr.
 * Used alongside the NDJSON so a live audience can follow the acquisition loop.
 */
export function demo(message: string): void {
  if (LEVEL_RANK.info > LEVEL_RANK[activeLevel]) return;
  console.error(`[Deycid] ${message}`);
}

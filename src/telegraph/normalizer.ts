import type { EvidenceQuality, EvidenceStance } from '../types/evidence.js';

/**
 * Turns a miner's raw output into a stance Deycid can reason about.
 *
 * The Telegraph docs are explicit that `result` "shape varies per miner", so
 * this module never assumes a schema. It flattens the response to leaf paths
 * and runs three passes, in descending order of trust:
 *
 *   1. Structured markers — typed booleans and numeric scores on recognised
 *      key names (`malicious`, `risk_score`, `tvl_usd`, ...). Quality HIGH.
 *   2. Status strings — recognised state words on state-ish key names
 *      (`status: "success"`, `state: "reverted"`). Quality MEDIUM.
 *   3. Lexical polarity — a documented keyword lexicon scanned over the
 *      miner's *conclusion* fields, with negation handling. Quality LOW.
 *
 * When no pass produces a reading the stance is UNCERTAIN, which is distinct
 * from NEUTRAL: UNCERTAIN means "could not tell", NEUTRAL means "read it, it
 * leans neither way".
 *
 * Everything here is deterministic and inspectable. No LLM is consulted to
 * decide what a miner's answer means.
 *
 * ── Lessons from the first live run ─────────────────────────────────────────
 * Three rules below exist because an earlier version got real answers wrong,
 * and each is pinned by a fixture in tests/normalizer-live-fixtures.test.ts
 * built from actual miner responses:
 *
 *   - **Negation.** A fraud miner answering "No evidence links this address to
 *     known scams, drains or phishing" contains every alarming word in the
 *     lexicon. Scanned naively it reads as an accusation. Polarity terms are
 *     therefore evaluated per sentence, and a negator appearing before the
 *     term flips its sign.
 *   - **Scope.** Miners echo the request back (`query`, `request`) and return
 *     source material (`results[].content`) that may be about something else
 *     entirely — one search miner returned an unrelated CVE advisory. The
 *     lexical pass therefore reads only fields that carry the miner's own
 *     conclusion, and the echoed request is subtracted from the text.
 *   - **Metadata.** Pipeline bookkeeping (`provenance_events[].status:
 *     "SUCCESS"`, `research_state...status: "COMPLETED"`) is not a claim about
 *     the decision. Metadata paths are excluded from every pass.
 */

export interface NormalizedFinding {
  stance: EvidenceStance;
  quality: EvidenceQuality;
  /** One-line human summary of what was read. */
  finding: string;
  /** Named markers that fired, e.g. `malicious=true`. Kept for auditability. */
  matchedSignals: string[];
}

interface Leaf {
  path: string;
  key: string;
  value: unknown;
}

const MAX_LEAVES = 600;
const MAX_DEPTH = 8;

/** Flattens an arbitrary JSON value into leaf paths, bounded in size and depth. */
function flatten(value: unknown, path = '', depth = 0, out: Leaf[] = []): Leaf[] {
  if (out.length >= MAX_LEAVES || depth > MAX_DEPTH) return out;

  if (value === null || typeof value !== 'object') {
    const key = path.replace(/\[\d+\]$/, '').split('.').pop() ?? path;
    out.push({ path, key: key.toLowerCase(), value });
    return out;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length && out.length < MAX_LEAVES; i += 1) {
      flatten(value[i], `${path}[${i}]`, depth + 1, out);
    }
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (out.length >= MAX_LEAVES) break;
    flatten(v, path ? `${path}.${k}` : k, depth + 1, out);
  }
  return out;
}

/**
 * Path segments that carry pipeline bookkeeping, provenance, source material or
 * the echoed request rather than the miner's answer. Excluded from every pass.
 */
const METADATA_SEGMENT =
  /^(provenance|provenance_events|provenance_graph|provenance_receipts|evidence|evidence_ledger|evidence_id|research_state|capability_attempts|sources|source_time|images|follow_up_questions|request_id|response_time|schema_version|attribution|trace|logs?|debug|_meta|meta|query|request|question|prompt|input|raw_request)$/;

function isMetadataPath(path: string): boolean {
  for (const rawSegment of path.split('.')) {
    const segment = rawSegment.replace(/\[\d+\]$/, '').toLowerCase();
    if (METADATA_SEGMENT.test(segment)) return true;
  }
  return false;
}

/** Conventional unit/format suffixes on a value key, e.g. `tvl_usd`. */
const UNIT_SUFFIX = '(?:_(?:usd|usdc|eth|native|raw|wei|value|total|amount|num|count))?';

/** Boolean-ish key names where `true` means danger. */
const NEGATIVE_FLAG_KEYS = new RegExp(
  `^(?:is_|has_)?(malicious|phishing|phish|scam|fraud|fraudulent|blacklisted|blocked|banned|unsafe|suspicious|compromised|rugpull|rug_pull|honeypot|threat|spam)${UNIT_SUFFIX}$`,
);

/** Boolean-ish key names where `true` means all clear. */
const POSITIVE_FLAG_KEYS = new RegExp(
  `^(?:is_)?(safe|valid|verified|legitimate|clean|confirmed|success|successful|ok)${UNIT_SUFFIX}$`,
);

/** Numeric key names carrying a risk score on a 0..1 or 0..100 scale. */
const RISK_SCORE_KEYS =
  /^(risk|threat|fraud|scam|malicious|abuse|phishing)_?(score|level|rating|probability)?$/;

/** Numeric key names where a positive value is reassuring. */
const POSITIVE_MAGNITUDE_KEYS = new RegExp(
  `^(balance|balances|amount|price|current_price|usd_value|tvl|total_value_locked|holders|holder_count|liquidity|supply)${UNIT_SUFFIX}$`,
);

/** Key names whose string value describes a state. */
const STATUS_KEYS =
  /^(status|state|tx_status|transaction_status|result_status|verdict|outcome|disposition)$/;

const POSITIVE_STATUS_WORDS = new Set([
  'success', 'successful', 'succeeded', 'confirmed', 'finalized', 'complete', 'completed',
  'ok', 'valid', 'safe', 'clean', 'verified', 'active', 'harmless', 'benign', 'no_risk', 'low_risk',
]);

const NEGATIVE_STATUS_WORDS = new Set([
  'failed', 'failure', 'reverted', 'revert', 'error', 'invalid', 'rejected', 'malicious',
  'phishing', 'scam', 'fraud', 'blacklisted', 'blocked', 'unsafe', 'suspicious', 'high_risk',
  'critical', 'dangerous',
]);

/**
 * Keys carrying the miner's own conclusion. Only these are read by the lexical
 * pass — deliberately an allowlist, because the alternative (scanning every
 * string) reads echoed prompts and unrelated source documents as findings.
 */
const CONCLUSION_KEYS =
  /^(summary|explanation|answer|signal|finding|findings|conclusion|verdict|reason|rationale|readings|assessment|analysis|description|message|note|notes|text|output|result_text)$/;

const NEGATIVE_TERMS = [
  'hack', 'hacked', 'exploit', 'exploited', 'drained', 'rug pull', 'rugpull', 'scam',
  'phishing', 'stolen', 'breach', 'vulnerability', 'vulnerabilities', 'insolvency', 'insolvent',
  'depeg', 'depegged', 'halted', 'paused', 'lawsuit', 'sanctioned', 'blacklisted',
  'compromised', 'malicious', 'fraud',
];

const POSITIVE_TERMS = [
  'audited', 'secure', 'resolved', 'operating normally', 'legitimate', 'verified',
  'stable', 'healthy', 'no issues', 'no incidents',
];

/**
 * Words that negate a polarity term appearing later in the same sentence.
 * Sentence scoping is what keeps "The protocol was hacked. No issues since."
 * from being read as an all-clear.
 */
const NEGATORS = [
  'no', 'not', 'never', 'without', 'absence', 'absent', 'free of', 'clear of', 'devoid',
  'nor', 'neither', 'lacks', 'lacking', 'excludes', 'excluding', 'unable to find',
  'does not', 'do not', 'did not', "doesn't", "don't", "didn't", 'none', 'nothing',
];

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === 'true' || s === 'yes') return true;
    if (s === 'false' || s === 'no') return false;
  }
  return undefined;
}

/** Normalises a risk score onto 0..1, tolerating 0..100 scales. */
function normalizeRiskScore(n: number): number {
  if (n > 1 && n <= 100) return n / 100;
  return Math.min(Math.max(n, 0), 1);
}

/**
 * Compiled once. Building these per sentence turned the lexical pass into
 * dozens of regex compilations per response for no benefit.
 *
 * The `(^|[^a-z])…([^a-z]|$)` guard makes each a whole-word match, so "no"
 * does not fire inside "none" (which is listed separately) or "note".
 */
const NEGATOR_PATTERNS: readonly RegExp[] = NEGATORS.map(
  (negator) => new RegExp(`(^|[^a-z])${negator}([^a-z]|$)`),
);

/** Index of the earliest negator in a sentence, or -1. */
function earliestNegator(sentence: string): number {
  let earliest = -1;
  for (const pattern of NEGATOR_PATTERNS) {
    const idx = sentence.search(pattern);
    if (idx !== -1 && (earliest === -1 || idx < earliest)) earliest = idx;
  }
  return earliest;
}

/**
 * A currency figure stated in prose: `$0.9998`, `$17.93 billion`, `$1,204.50`.
 *
 * Requires the currency marker. A bare number is not enough — the gas miner
 * answers "0.222798271 gwei", which is a real measurement but says nothing
 * about whether the decision should proceed.
 */
const MONEY_IN_TEXT = /\$\s?([\d,]+(?:\.\d+)?)\s*(trillion|billion|million|bn|mn|[kmb])?\b/gi;

const SCALE: Record<string, number> = {
  trillion: 1e12, billion: 1e9, million: 1e6, bn: 1e9, mn: 1e6, k: 1e3, m: 1e6, b: 1e9,
};

/**
 * Extracts currency figures from a conclusion.
 *
 * Telegraph routes probabilistically, so the same intent returns a structured
 * `price` field from one miner and a prose sentence from another. Without this,
 * Deycid reads the first and is blind to the second.
 */
function scoreMoney(text: string): LexicalTally {
  const tally: LexicalTally = { positive: 0, negative: 0, signals: [] };
  let match: RegExpExecArray | null;

  MONEY_IN_TEXT.lastIndex = 0;
  while ((match = MONEY_IN_TEXT.exec(text)) !== null) {
    const raw = Number(match[1]!.replace(/,/g, ''));
    if (!Number.isFinite(raw)) continue;
    const scale = match[2] ? (SCALE[match[2].toLowerCase()] ?? 1) : 1;
    const value = raw * scale;

    if (value > 0) {
      tally.positive += 1;
      tally.signals.push(`text:$${raw}${match[2] ?? ''}`);
    } else {
      tally.negative += 1;
      tally.signals.push(`text:$${raw}`);
    }
    if (tally.signals.length >= 4) break;
  }

  return tally;
}

interface LexicalTally {
  positive: number;
  negative: number;
  signals: string[];
}

/**
 * Scores polarity terms sentence by sentence, flipping a term's sign when a
 * negator precedes it in the same sentence.
 *
 * Known limitation, accepted for an MVP heuristic: "there is no doubt this was
 * a hack" negates incorrectly. Sentence-scoped negation is a large improvement
 * on none, and the pass only ever yields LOW quality, which the confidence
 * engine already discounts.
 */
function scoreLexical(text: string): LexicalTally {
  const tally: LexicalTally = { positive: 0, negative: 0, signals: [] };

  for (const sentence of text.split(/[.!?;\n]+/)) {
    const s = sentence.toLowerCase();
    if (s.trim() === '') continue;
    const negatorAt = earliestNegator(s);

    for (const term of NEGATIVE_TERMS) {
      const at = s.indexOf(term);
      if (at === -1) continue;
      const negated = negatorAt !== -1 && negatorAt < at;
      if (negated) {
        tally.positive += 1;
        tally.signals.push(`text:+not("${term}")`);
      } else {
        tally.negative += 1;
        tally.signals.push(`text:-"${term}"`);
      }
    }

    for (const term of POSITIVE_TERMS) {
      const at = s.indexOf(term);
      if (at === -1) continue;
      const negated = negatorAt !== -1 && negatorAt < at;
      if (negated) {
        tally.negative += 1;
        tally.signals.push(`text:-not("${term}")`);
      } else {
        tally.positive += 1;
        tally.signals.push(`text:+"${term}"`);
      }
    }
  }

  return tally;
}

/**
 * Reads a stance out of a miner response.
 *
 * @param result   The miner's raw `result` payload.
 * @param warnings Advisory notes Telegraph attached. Their presence never flips
 *                 a stance, only appears in the finding.
 * @param request  The query Deycid sent. Subtracted from the scanned text so a
 *                 miner echoing the prompt cannot be read as answering it.
 */
export function normalizeResult(
  result: unknown,
  warnings: readonly string[] = [],
  request?: string,
): NormalizedFinding {
  if (result === null || result === undefined) {
    return {
      stance: 'UNCERTAIN',
      quality: 'LOW',
      finding: 'Miner returned no result payload.',
      matchedSignals: [],
    };
  }

  const leaves = flatten(result).filter((l) => !isMetadataPath(l.path));
  const matched: string[] = [];
  let positive = 0;
  let negative = 0;
  let quality: EvidenceQuality | undefined;

  // ---- Pass 1: structured markers (HIGH) -----------------------------------
  for (const leaf of leaves) {
    const bool = asBoolean(leaf.value);
    if (bool !== undefined && NEGATIVE_FLAG_KEYS.test(leaf.key)) {
      matched.push(`${leaf.path}=${bool}`);
      if (bool) negative += 2;
      else positive += 1.5;
      quality = 'HIGH';
      continue;
    }
    if (bool !== undefined && POSITIVE_FLAG_KEYS.test(leaf.key)) {
      matched.push(`${leaf.path}=${bool}`);
      if (bool) positive += 1.5;
      else negative += 1.5;
      quality = 'HIGH';
      continue;
    }

    const num = asNumber(leaf.value);
    if (num !== undefined && RISK_SCORE_KEYS.test(leaf.key)) {
      const score = normalizeRiskScore(num);
      matched.push(`${leaf.path}=${score.toFixed(2)}`);
      if (score >= 0.5) negative += 2;
      else if (score <= 0.25) positive += 1.5;
      quality = 'HIGH';
      continue;
    }
    if (num !== undefined && POSITIVE_MAGNITUDE_KEYS.test(leaf.key)) {
      matched.push(`${leaf.path}=${num}`);
      if (num > 0) positive += 1;
      else negative += 1;
      quality ??= 'HIGH';
    }
  }

  // ---- Pass 2: status strings (MEDIUM) ------------------------------------
  if (positive === 0 && negative === 0) {
    for (const leaf of leaves) {
      if (typeof leaf.value !== 'string' || !STATUS_KEYS.test(leaf.key)) continue;
      const word = leaf.value.trim().toLowerCase().replace(/\s+/g, '_');
      if (POSITIVE_STATUS_WORDS.has(word)) {
        matched.push(`${leaf.path}="${leaf.value}"`);
        positive += 1.5;
        quality = 'MEDIUM';
      } else if (NEGATIVE_STATUS_WORDS.has(word)) {
        matched.push(`${leaf.path}="${leaf.value}"`);
        negative += 1.5;
        quality = 'MEDIUM';
      }
    }
  }

  // ---- Pass 3: lexical polarity over conclusion fields only (LOW) ---------
  if (positive === 0 && negative === 0) {
    let text = leaves
      .filter((l) => typeof l.value === 'string' && CONCLUSION_KEYS.test(l.key))
      .map((l) => String(l.value))
      .join('. ')
      .slice(0, 20_000);

    // Remove the echoed request so Deycid cannot read its own question as the
    // miner's answer.
    if (request && request.trim() !== '') {
      text = text.split(request).join(' ');
    }

    if (text.trim() !== '') {
      const tally = scoreLexical(text);
      positive += tally.positive;
      negative += tally.negative;
      matched.push(...tally.signals);
      if (tally.positive > 0 || tally.negative > 0) quality = 'LOW';

      // A figure the miner actually stated is firmer than keyword polarity, so
      // it is read only when polarity found nothing and it earns MEDIUM.
      if (positive === 0 && negative === 0) {
        const money = scoreMoney(text);
        positive += money.positive;
        negative += money.negative;
        matched.push(...money.signals);
        if (money.positive > 0 || money.negative > 0) quality = 'MEDIUM';
      }
    }
  }

  if (positive === 0 && negative === 0) {
    return {
      stance: 'UNCERTAIN',
      quality: 'LOW',
      finding: 'Response carried no marker Deycid could read a direction from.',
      matchedSignals: [],
    };
  }

  const net = positive - negative;
  let stance: EvidenceStance;
  if (net > 0) stance = 'SUPPORTS';
  else if (net < 0) stance = 'CONTRADICTS';
  else stance = 'NEUTRAL';

  const finalQuality: EvidenceQuality = quality ?? 'LOW';
  const shown = matched.slice(0, 4).join(', ');
  const warnNote = warnings.length > 0 ? ` (${warnings.length} Telegraph warning(s))` : '';

  const finding =
    stance === 'SUPPORTS'
      ? `Evidence favours proceeding: ${shown}${warnNote}`
      : stance === 'CONTRADICTS'
        ? `Evidence argues against proceeding: ${shown}${warnNote}`
        : `Readable but balanced: ${shown}${warnNote}`;

  return { stance, quality: finalQuality, finding, matchedSignals: matched.slice(0, 12) };
}

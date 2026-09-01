import { z } from 'zod';

/**
 * Shapes returned by the Telegraph node.
 *
 * These mirror the documented Engine and discovery responses
 * (docs.telegraphprotocol.com/docs/using/engine-ask). Every field a miner
 * controls is treated as unknown-shaped and parsed leniently: the docs are
 * explicit that `result` varies per miner, so nothing below assumes a shape
 * Deycid has not verified.
 */

/** Canonical Telegraph intent name, e.g. `ONCHAIN_TX_LOOKUP`. */
export type IntentName = string;

/**
 * How Telegraph validators grade an intent.
 * Tier A answers have exactly one right answer and are graded by WASM exact
 * match; Tier B answers are open-ended and graded by an LLM-supplied context
 * plus WASM. Deycid treats Tier A as the more reliable evidence class.
 */
export const ScoringTierSchema = z.enum(['A_DETERMINISTIC', 'B_LLM_JUDGE']);
export type ScoringTier = z.infer<typeof ScoringTierSchema>;

/** `GET /engine/v1/intents` — one entry. */
export const TelegraphIntentSchema = z.object({
  intent_id: z.string(),
  intent_name: z.string(),
  miner_count: z.number().int().nonnegative().optional(),
  description: z.string().optional(),
  canonical: z.boolean().optional(),
});
export type TelegraphIntent = z.infer<typeof TelegraphIntentSchema>;

export const TelegraphIntentListSchema = z.object({
  count: z.number().int().nonnegative().optional(),
  canonical_on_chain: z.number().int().nonnegative().optional(),
  intents: z.array(TelegraphIntentSchema),
});
export type TelegraphIntentList = z.infer<typeof TelegraphIntentListSchema>;

/**
 * `POST /engine/v1/ask` success body.
 *
 * `intent` and `reasoning` are documented as omitted when empty, and
 * `signal_hash` as omitted when the ask failed — so all three are optional.
 */
export const EngineAskResponseSchema = z.object({
  miner_id: z.union([z.string(), z.number()]).optional(),
  miner_name: z.string().optional(),
  endpoint: z.string().optional(),
  result: z.unknown(),
  cost_usd: z.number().optional(),
  duration_ms: z.number().optional(),
  timestamp: z.string().optional(),
  reasoning: z.string().optional(),
  intent: z.string().optional(),
  signal_hash: z.string().optional(),
  warnings: z.array(z.string()).optional(),
});
export type EngineAskResponse = z.infer<typeof EngineAskResponseSchema>;

/** `GET /api/miners` — the fields Deycid actually reads. */
export const TelegraphMinerSchema = z.object({
  id: z.union([z.string(), z.number()]),
  slug: z.string().optional(),
  name: z.string().optional(),
  supported_intents: z.array(z.string()).optional(),
  activation_status: z.string().optional(),
  min_price_usdc: z.union([z.string(), z.number()]).optional(),
});
export type TelegraphMiner = z.infer<typeof TelegraphMinerSchema>;

/**
 * One completed Telegraph inference, as Deycid records it.
 *
 * `routedIntent` is what Telegraph's router actually classified the query as —
 * Deycid does not choose it. `requestedIntent` is the intent Deycid shaped the
 * query to reach. The two are kept separate because a mismatch is a real signal
 * about how relevant the answer is.
 */
export interface TelegraphAskRecord {
  requestId: string;
  requestedIntent: IntentName;
  routedIntent?: string;
  minerId?: string;
  minerName?: string;
  routingReasoning?: string;
  /** The miner's raw output. Shape varies per miner. */
  result: unknown;
  /** Telegraph's own reported cost for the call, in USD. */
  costUsd?: number;
  durationMs?: number;
  /** Hash Telegraph recorded the call under; re-checkable at /engine/v1/signal/{hash}. */
  signalHash?: string;
  warnings: string[];
  /** ISO timestamp Telegraph reported, when it reported one. */
  telegraphTimestamp?: string;
  /** ISO timestamp Deycid received the response. */
  receivedAt: string;
}

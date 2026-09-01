import type { DeycidConfig } from '../config/env.js';
import {
  TelegraphRequestError,
  TelegraphUnavailableError,
  UnsupportedIntentError,
  WalletUnavailableError,
  X402PaymentError,
} from '../errors.js';
import type { X402PayFetch } from '../payments/x402-client.js';
import type { PaymentReceipt } from '../types/payment.js';
import {
  EngineAskResponseSchema,
  TelegraphIntentListSchema,
  TelegraphMinerSchema,
  type IntentName,
  type TelegraphAskRecord,
  type TelegraphIntent,
  type TelegraphMiner,
} from '../types/telegraph.js';
import { newId } from '../utils/ids.js';
import { logger } from '../utils/logger.js';
import { getIntent } from './intents.js';

/**
 * Telegraph transport.
 *
 * This is the only module that knows Telegraph's URLs, wire format, or payment
 * mechanics. The decision engine talks to the interface below and never sees an
 * HTTP detail — swapping the transport (or mocking it in tests) touches nothing
 * downstream.
 *
 * Endpoints used, all from the official docs:
 *   POST /engine/v1/ask          auto-routed inference   (x402, paid)
 *   GET  /engine/v1/intents      canonical intent list   (free)
 *   GET  /engine/v1/signal/{h}   look a recorded call up (free)
 *   GET  /api/miners             live miner catalogue    (free)
 */

export interface AskOutcome {
  record: TelegraphAskRecord;
  receipt?: PaymentReceipt;
}

/** The surface the decision engine depends on. Mocked wholesale in unit tests. */
export interface TelegraphClientLike {
  askIntent(intent: IntentName, query: string, context?: Record<string, unknown>): Promise<AskOutcome>;
  getAvailableIntents(): Promise<TelegraphIntent[]>;
  getIntentMetadata(intent: IntentName): Promise<TelegraphIntent | undefined>;
  getMiners(intent?: IntentName): Promise<TelegraphMiner[]>;
  getSignalStatus(signalHash: string): Promise<unknown>;
  canPay(): boolean;
}

/** Statuses worth a second attempt. 402 is absent on purpose. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Truncates untrusted upstream text before it reaches a log or an error. */
function snippet(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

export class TelegraphClient implements TelegraphClientLike {
  readonly #config: DeycidConfig;
  readonly #pay: X402PayFetch | undefined;
  #intentCache: { at: number; intents: TelegraphIntent[] } | undefined;

  constructor(config: DeycidConfig, pay?: X402PayFetch) {
    this.#config = config;
    this.#pay = pay;
  }

  canPay(): boolean {
    return this.#pay !== undefined;
  }

  /**
   * Buys one piece of intelligence.
   *
   * Telegraph's auto-routed ask takes a natural-language query, not an intent —
   * its own LLM router classifies the query and selects a miner. `intent` here
   * is therefore what Deycid *aimed* for; `record.routedIntent` is what
   * Telegraph actually chose. Deycid records both and lets the confidence
   * engine discount a mismatch.
   */
  async askIntent(
    intent: IntentName,
    query: string,
    context?: Record<string, unknown>,
  ): Promise<AskOutcome> {
    if (!getIntent(intent)) {
      throw new UnsupportedIntentError(`Deycid has no registry entry for intent "${intent}".`, { intent });
    }
    if (!this.#pay) {
      throw new WalletUnavailableError(
        'Telegraph inference is paid via x402 and no agent wallet is configured. Set AGENT_PRIVATE_KEY to enable paid intelligence.',
      );
    }

    const requestId = newId('req');
    const url = `${this.#config.telegraphEngineUrl}/v1/ask`;
    const body = JSON.stringify(context && Object.keys(context).length > 0 ? { query, context } : { query });

    logger.info('intelligence.requested', { requestId, requestedIntent: intent, url });

    const started = Date.now();
    // The body is read inside the timeout window. Reading it afterwards would
    // leave a slow or stalled response streaming with no deadline attached.
    const { response, receipt: rawReceipt, text } = await this.#withTimeout(
      async (signal) => {
        const paid = await this.#pay!.fetchWithPayment(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body,
          signal,
        });
        return { ...paid, text: await paid.response.text() };
      },
      url,
    );

    if (!response.ok) {
      // The docs note the payment gate runs first, so a 402 surviving to here
      // means the exchange itself did not complete rather than that the request
      // was merely unpaid.
      if (response.status === 402) {
        throw new X402PaymentError(
          'Telegraph still reports payment required after the x402 exchange. The signed payload was not accepted.',
          { requestId, body: snippet(text) },
        );
      }
      throw new TelegraphRequestError(
        `Telegraph ask failed with HTTP ${response.status}.`,
        response.status,
        { requestId, requestedIntent: intent, body: snippet(text) },
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new TelegraphRequestError('Telegraph ask returned a body that is not JSON.', response.status, {
        requestId,
        body: snippet(text),
      });
    }

    const parsed = EngineAskResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new TelegraphRequestError('Telegraph ask returned an unexpected response shape.', response.status, {
        requestId,
        issues: parsed.error.issues.map((i) => i.path.join('.')).slice(0, 8),
      });
    }
    const data = parsed.data;

    const record: TelegraphAskRecord = {
      requestId,
      requestedIntent: intent,
      result: data.result,
      warnings: data.warnings ?? [],
      receivedAt: new Date().toISOString(),
      ...(data.intent ? { routedIntent: data.intent } : {}),
      ...(data.miner_id !== undefined ? { minerId: String(data.miner_id) } : {}),
      ...(data.miner_name ? { minerName: data.miner_name } : {}),
      ...(data.reasoning ? { routingReasoning: data.reasoning } : {}),
      ...(typeof data.cost_usd === 'number' ? { costUsd: data.cost_usd } : {}),
      ...(typeof data.duration_ms === 'number' ? { durationMs: data.duration_ms } : { durationMs: Date.now() - started }),
      ...(data.signal_hash ? { signalHash: data.signal_hash } : {}),
      ...(data.timestamp ? { telegraphTimestamp: data.timestamp } : {}),
    };

    logger.info('intelligence.received', {
      requestId,
      requestedIntent: intent,
      routedIntent: record.routedIntent,
      minerName: record.minerName,
      costUsd: record.costUsd,
      signalHash: record.signalHash,
      warnings: record.warnings.length,
    });

    const receipt: PaymentReceipt | undefined = rawReceipt
      ? { ...rawReceipt, requestId, requestedIntent: intent }
      : undefined;

    return { record, ...(receipt ? { receipt } : {}) };
  }

  /** Canonical intents the node currently recognises, cached for 5 minutes. */
  async getAvailableIntents(): Promise<TelegraphIntent[]> {
    const fresh = this.#intentCache && Date.now() - this.#intentCache.at < 300_000;
    if (fresh && this.#intentCache) return this.#intentCache.intents;

    const json = await this.#getJson(`${this.#config.telegraphEngineUrl}/v1/intents`);
    const parsed = TelegraphIntentListSchema.safeParse(json);
    if (!parsed.success) {
      throw new TelegraphRequestError('Telegraph intent list returned an unexpected shape.', 200, {
        issues: parsed.error.issues.map((i) => i.path.join('.')).slice(0, 8),
      });
    }
    this.#intentCache = { at: Date.now(), intents: parsed.data.intents };
    return parsed.data.intents;
  }

  async getIntentMetadata(intent: IntentName): Promise<TelegraphIntent | undefined> {
    const all = await this.getAvailableIntents();
    return all.find((i) => i.intent_name === intent);
  }

  async getMiners(intent?: IntentName): Promise<TelegraphMiner[]> {
    const url = new URL(`${this.#config.telegraphNodeUrl}/api/miners`);
    if (intent) url.searchParams.set('intent', intent);
    const json = await this.#getJson(url.toString());
    if (!Array.isArray(json)) return [];
    const out: TelegraphMiner[] = [];
    for (const entry of json) {
      const parsed = TelegraphMinerSchema.safeParse(entry);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  /**
   * Looks up a recorded signal by hash.
   * Telegraph records every paid call under a `signal_hash`; this is how a
   * decision receipt stays independently checkable after the fact.
   */
  async getSignalStatus(signalHash: string): Promise<unknown> {
    if (!/^0x[0-9a-fA-F]+$/.test(signalHash)) {
      throw new TelegraphRequestError('signalHash must be a 0x-prefixed hex string.', 400, {});
    }
    return this.#getJson(`${this.#config.telegraphEngineUrl}/v1/signal/${signalHash}`);
  }

  /** Free GET with timeout and bounded exponential backoff. */
  async #getJson(url: string): Promise<unknown> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        // Status and body are both taken inside the timeout window.
        const { status, ok, text } = await this.#withTimeout(async (signal) => {
          const r = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal });
          return { status: r.status, ok: r.ok, text: await r.text() };
        }, url);

        if (!ok) {
          const err = new TelegraphRequestError(`Telegraph GET failed with HTTP ${status}.`, status, {
            url,
            body: snippet(text),
          });
          if (RETRYABLE_STATUS.has(status) && attempt < MAX_ATTEMPTS) {
            lastError = err;
            await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
            continue;
          }
          throw err;
        }

        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new TelegraphRequestError('Telegraph GET returned a body that is not JSON.', status, {
            url,
            body: snippet(text),
          });
        }
      } catch (err) {
        // Only transport-level faults are retried; a shaped protocol error is
        // final and rethrows immediately above.
        if (err instanceof TelegraphRequestError) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt >= MAX_ATTEMPTS) break;
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }

    throw new TelegraphUnavailableError(`Could not reach Telegraph at ${url}.`, {
      url,
      cause: lastError?.message,
    });
  }

  /**
   * Applies the configured timeout to one attempt.
   * Every outbound call goes through here — a hung Telegraph request must never
   * be able to wedge the MCP process.
   */
  async #withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.requestTimeoutMs);
    try {
      return await run(controller.signal);
    } catch (err) {
      if (controller.signal.aborted) {
        throw new TelegraphUnavailableError(
          `Telegraph request timed out after ${this.#config.requestTimeoutMs}ms.`,
          { url, timeoutMs: this.#config.requestTimeoutMs },
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

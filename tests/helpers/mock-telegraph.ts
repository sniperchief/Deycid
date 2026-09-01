import type { AskOutcome, TelegraphClientLike } from '../../src/telegraph/client.js';
import type { IntentName, TelegraphIntent, TelegraphMiner } from '../../src/types/telegraph.js';

/**
 * Test double for the Telegraph transport.
 *
 * This exists ONLY for automated tests. Deycid ships no mock Telegraph mode:
 * the production server always talks to a real node, and the hackathon rules
 * require exactly that. Mocking here is what lets the decision engine be tested
 * without spending USDC or depending on live miner behaviour.
 */

export interface ScriptedResponse {
  /** Miner payload to return for this intent. */
  result: unknown;
  /** Intent Telegraph "routed" to. Defaults to the requested intent. */
  routedIntent?: string;
  costUsd?: number;
  signalHash?: string;
  warnings?: string[];
  minerName?: string;
  /** ISO timestamp Telegraph reports, used to exercise freshness decay. */
  telegraphTimestamp?: string;
  /** When set, the ask rejects with this error instead of answering. */
  throws?: Error;
}

export class MockTelegraphClient implements TelegraphClientLike {
  readonly calls: { intent: IntentName; query: string; context?: Record<string, unknown> }[] = [];
  #script = new Map<IntentName, ScriptedResponse[]>();
  #fallback: ScriptedResponse | undefined;
  #canPay = true;

  /** Queues responses for an intent; consumed in order, last one repeats. */
  on(intent: IntentName, ...responses: ScriptedResponse[]): this {
    this.#script.set(intent, responses);
    return this;
  }

  /** Response for any intent without a specific script. */
  fallback(response: ScriptedResponse): this {
    this.#fallback = response;
    return this;
  }

  setCanPay(value: boolean): this {
    this.#canPay = value;
    return this;
  }

  canPay(): boolean {
    return this.#canPay;
  }

  async askIntent(
    intent: IntentName,
    query: string,
    context?: Record<string, unknown>,
  ): Promise<AskOutcome> {
    this.calls.push({ intent, query, ...(context ? { context } : {}) });

    const queue = this.#script.get(intent);
    const scripted = queue && queue.length > 0 ? (queue.length > 1 ? queue.shift()! : queue[0]!) : this.#fallback;

    if (!scripted) {
      throw new Error(`MockTelegraphClient has no script for intent ${intent}`);
    }
    if (scripted.throws) throw scripted.throws;

    const cost = scripted.costUsd ?? 0.01;
    const now = new Date().toISOString();

    return {
      record: {
        requestId: `req-${this.calls.length}`,
        requestedIntent: intent,
        routedIntent: scripted.routedIntent ?? intent,
        result: scripted.result,
        warnings: scripted.warnings ?? [],
        costUsd: cost,
        durationMs: 120,
        receivedAt: now,
        telegraphTimestamp: scripted.telegraphTimestamp ?? now,
        minerName: scripted.minerName ?? 'mock-miner',
        minerId: '999',
        ...(scripted.signalHash ? { signalHash: scripted.signalHash } : { signalHash: '0xabc123' }),
      },
      receipt: {
        requestId: `req-${this.calls.length}`,
        requestedIntent: intent,
        amountUsdc: cost,
        amountAtomic: String(Math.round(cost * 1e6)),
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        network: 'eip155:84532',
        settled: true,
        transaction: '0xdeadbeef',
        timestamp: now,
      },
    };
  }

  async getAvailableIntents(): Promise<TelegraphIntent[]> {
    return [
      { intent_id: 'ONCHAIN_TX_LOOKUP', intent_name: 'ONCHAIN_TX_LOOKUP', miner_count: 12 },
      { intent_id: 'WALLET_BALANCE_CHECK', intent_name: 'WALLET_BALANCE_CHECK', miner_count: 10 },
      { intent_id: 'CRYPTO_PRICE', intent_name: 'CRYPTO_PRICE', miner_count: 14 },
    ];
  }

  async getIntentMetadata(intent: IntentName): Promise<TelegraphIntent | undefined> {
    return (await this.getAvailableIntents()).find((i) => i.intent_name === intent);
  }

  async getMiners(): Promise<TelegraphMiner[]> {
    return [{ id: '999', slug: 'mock-miner', activation_status: 'active', min_price_usdc: '10000' }];
  }

  async getSignalStatus(): Promise<unknown> {
    return { signal: '0xabc123', verified: true };
  }
}

/** A transaction lookup that reads as clearly successful. */
export const OK_TX = { status: 'success', from: '0xaaa', to: '0xbbb', value: '1000' };
/** A balance response with funds present. */
export const OK_BALANCE = { balance: 42.5, symbol: 'USDC' };
/** A fraud check that fires a structured negative marker. */
export const BAD_FRAUD = { malicious: true, risk_score: 0.93 };
/** A fraud check that reads clean. */
export const OK_FRAUD = { malicious: false, risk_score: 0.02 };

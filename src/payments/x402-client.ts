import { AsyncLocalStorage } from 'node:async_hooks';
import { x402Client } from '@x402/core/client';
import type { Network, PaymentRequirements } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { BASE_SEPOLIA_CAIP2, BASE_SEPOLIA_USDC, type DeycidConfig } from '../config/env.js';
import { X402PaymentError } from '../errors.js';
import type { PaymentReceipt } from '../types/payment.js';
import { logger } from '../utils/logger.js';
import type { AgentWallet } from './wallet.js';

/**
 * x402 payment transport.
 *
 * Telegraph gates inference behind x402: the first request comes back `402`
 * with a base64 `PAYMENT-REQUIRED` challenge, the client signs an EIP-3009
 * authorization over the token's own EIP-712 domain, and retries with
 * `PAYMENT-SIGNATURE`. The docs are explicit that hand-rolling the payload is a
 * mistake — a malformed one is rejected as a bare 402, indistinguishable from
 * not paying — so this delegates the whole exchange to the official `@x402/*`
 * packages and confines itself to two jobs Deycid actually needs:
 *
 *   1. constraining which payment option is accepted, and
 *   2. capturing the real settlement proof for the decision receipt.
 *
 * Nothing here fabricates a receipt. Every field on the emitted
 * `PaymentReceipt` is copied from the signed requirements or the facilitator's
 * settlement response; when the facilitator does not report a field, it stays
 * undefined.
 */

/** Mutable slot a single paid request accumulates its proof into. */
interface ReceiptDraft {
  requirements?: PaymentRequirements;
  transaction?: string;
  payer?: string;
  network?: string;
  settled: boolean;
  settlementError?: string;
  /** Set when the client refused to pay at all (spend controls, no option). */
  aborted?: string;
  /**
   * How many payment authorizations were signed for this one request.
   *
   * Must be 1. `wrapFetchWithPayment` will sign a second authorization and
   * issue a third request if a payment-response hook returns
   * `{ recovered: true }` — which is how one logical call could be paid for
   * twice. Deycid's hook below deliberately never returns `recovered`, and
   * this counter makes a violation of that invariant visible instead of
   * silently under-reporting spend.
   */
  attempts: number;
}

export interface PaidFetchResult {
  response: Response;
  /** Present when a payment was actually created for this request. */
  receipt?: Omit<PaymentReceipt, 'requestId' | 'requestedIntent'>;
}

/** USDC and the other x402 default assets are 6-decimal. */
const USDC_DECIMALS = 6;

function atomicToUsdc(amount: string, decimals = USDC_DECIMALS): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return n / 10 ** decimals;
}

export class X402PayFetch {
  readonly #store = new AsyncLocalStorage<ReceiptDraft>();
  readonly #fetch: typeof globalThis.fetch;
  readonly #network: Network;
  readonly #maxPerCallUsdc: number;

  constructor(wallet: AgentWallet, config: DeycidConfig) {
    // `loadConfig` already enforces the CAIP-2 `namespace:reference` shape that
    // x402's `Network` template type expects.
    this.#network = config.paymentNetwork as Network;
    this.#maxPerCallUsdc = config.maxPaymentPerCallUsdc;

    const client = new x402Client(this.#selectRequirements);

    registerExactEvmScheme(client, {
      signer: wallet.signer,
      networks: [this.#network],
    });

    // Hard ceiling enforced inside the payment client itself, before a case's
    // own budget arithmetic ever runs. Two independent brakes on spend.
    client.setSpendControls({ maxAmountPerPayment: `$${this.#maxPerCallUsdc}` });

    client.onBeforePaymentCreation(async (ctx) => {
      const draft = this.#store.getStore();
      const selected = ctx.selectedRequirements;
      if (draft) {
        draft.attempts += 1;
        if (selected) draft.requirements = selected;
      }

      const usdc = selected?.amount ? atomicToUsdc(selected.amount) : undefined;
      if (usdc !== undefined && usdc > this.#maxPerCallUsdc) {
        const reason = `Quoted ${usdc.toFixed(6)} USDC exceeds MAX_PAYMENT_PER_CALL_USDC (${this.#maxPerCallUsdc}).`;
        if (draft) draft.aborted = reason;
        return { abort: true, reason };
      }
      logger.info('payment.required', {
        amountUsdc: usdc,
        network: selected?.network,
        asset: selected?.asset,
      });
      return undefined;
    });

    client.onPaymentResponse(async (ctx) => {
      const draft = this.#store.getStore();
      if (!draft) return undefined;

      draft.requirements = ctx.requirements ?? draft.requirements;

      if (ctx.settleResponse) {
        draft.settled = ctx.settleResponse.success === true;
        draft.transaction = ctx.settleResponse.transaction || undefined;
        draft.payer = ctx.settleResponse.payer;
        draft.network = ctx.settleResponse.network;
        if (!draft.settled) {
          draft.settlementError =
            ctx.settleResponse.errorMessage ?? ctx.settleResponse.errorReason ?? 'settlement reported failure';
        }
      } else if (ctx.paymentRequired) {
        draft.settled = false;
        draft.settlementError = 'payment verification failed; node re-issued a challenge';
      } else if (ctx.error) {
        draft.settled = false;
        draft.settlementError = ctx.error.message;
      }
      // Never return `{ recovered: true }`. Doing so makes the transport sign a
      // fresh authorization and retry, which risks paying twice for one answer.
      // A failed payment surfaces to the caller instead.
      return undefined;
    });

    this.#fetch = wrapFetchWithPayment(fetch, client);
  }

  /**
   * Chooses which of the node's offered payment options to sign.
   *
   * Telegraph's challenge advertises both an EVM and a Solana option. Deycid
   * pays on exactly the CAIP-2 network it was configured for and refuses rather
   * than silently falling back to another chain or asset.
   */
  readonly #selectRequirements = (
    _x402Version: number,
    requirements: PaymentRequirements[],
  ): PaymentRequirements => {
    const match = requirements.find((r) => r.network === this.#network);
    if (match) {
      // Sanity check, not a gate: the node is authoritative about what it wants
      // paid in, but an unexpected asset on a network we know is worth flagging
      // before it is signed for.
      if (
        this.#network === BASE_SEPOLIA_CAIP2 &&
        match.asset.toLowerCase() !== BASE_SEPOLIA_USDC.toLowerCase()
      ) {
        logger.warn('payment.required', {
          note: 'Challenge asset is not the USDC contract Deycid expects on this network.',
          network: match.network,
          offeredAsset: match.asset,
          expectedAsset: BASE_SEPOLIA_USDC,
        });
      }
      return match;
    }

    const offered = requirements.map((r) => r.network).join(', ') || '(none)';
    throw new X402PaymentError(
      `Telegraph offered no payment option on the configured network ${this.#network}. Offered: ${offered}.`,
      { configuredNetwork: this.#network, offered },
    );
  };

  /**
   * Performs a request, completing the x402 exchange if one is demanded.
   *
   * Payment is never retried here. The x402 client makes exactly one payment
   * attempt per call; a failure surfaces to the caller, which decides whether
   * a *fresh* request is warranted. Retrying a signed authorization blindly is
   * how you pay twice for one answer.
   */
  async fetchWithPayment(url: string, init: RequestInit): Promise<PaidFetchResult> {
    const draft: ReceiptDraft = { settled: false, attempts: 0 };

    const response = await this.#store.run(draft, () => this.#fetch(url, init));

    if (draft.aborted) {
      throw new X402PaymentError(`Payment refused before signing. ${draft.aborted}`, {
        reason: draft.aborted,
      });
    }

    if (!draft.requirements) {
      // No payment was created — either the endpoint was free, or the request
      // failed before the challenge. Either way there is no receipt to report.
      return { response };
    }

    if (draft.attempts > 1) {
      // Should be unreachable: Deycid's payment-response hook never signals
      // recovery. Loud rather than silent, because the cost is real money.
      logger.warn('payment.failed', {
        note: 'More than one payment authorization was signed for a single request.',
        attempts: draft.attempts,
      });
    }

    const req = draft.requirements;
    const receipt: Omit<PaymentReceipt, 'requestId' | 'requestedIntent'> = {
      amountUsdc: atomicToUsdc(req.amount),
      amountAtomic: req.amount,
      asset: req.asset,
      network: draft.network ?? req.network,
      settled: draft.settled,
      timestamp: new Date().toISOString(),
      ...(draft.payer ? { payer: draft.payer } : {}),
      ...(draft.transaction ? { transaction: draft.transaction } : {}),
      ...(draft.settlementError ? { settlementError: draft.settlementError } : {}),
    };

    if (receipt.settled) {
      logger.info('payment.completed', {
        amountUsdc: receipt.amountUsdc,
        network: receipt.network,
        transaction: receipt.transaction,
      });
    } else {
      logger.warn('payment.failed', {
        amountUsdc: receipt.amountUsdc,
        network: receipt.network,
        reason: receipt.settlementError,
      });
    }

    return { response, receipt };
  }
}

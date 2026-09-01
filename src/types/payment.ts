import { z } from 'zod';

/**
 * Payment records.
 *
 * Every field here is copied from something the x402 exchange actually
 * produced — the decoded `PAYMENT-RESPONSE` settlement header, or the amount
 * Deycid signed for. Nothing is synthesized. When a field is absent from the
 * settlement proof it stays `undefined` rather than being filled in.
 */

export const PaymentReceiptSchema = z.object({
  /** Deycid's id for the Telegraph request this paid for. */
  requestId: z.string(),
  /** The intent Deycid shaped the request to reach. */
  requestedIntent: z.string(),
  /** Amount in USDC, derived from the atomic `amount` Deycid signed for. */
  amountUsdc: z.number().nonnegative(),
  /** Atomic units exactly as they appeared in the x402 payment requirements. */
  amountAtomic: z.string(),
  /** Token contract from the payment requirements. */
  asset: z.string(),
  /** CAIP-2 network the payment settled on, from the settlement proof. */
  network: z.string(),
  /** Payer address as reported by the facilitator, when it reports one. */
  payer: z.string().optional(),
  /** Settlement transaction, from the decoded PAYMENT-RESPONSE header. */
  transaction: z.string().optional(),
  /** Whether the facilitator reported the settlement as successful. */
  settled: z.boolean(),
  settlementError: z.string().optional(),
  timestamp: z.string(),
});
export type PaymentReceipt = z.infer<typeof PaymentReceiptSchema>;

/** Public, non-sensitive wallet metadata. Never carries key material. */
export interface AgentWalletInfo {
  address: `0x${string}`;
  /** CAIP-2 network the agent is configured to pay on. */
  network: string;
  /** Hard per-call ceiling enforced by the x402 client's spend controls. */
  maxPaymentPerCallUsdc: number;
}

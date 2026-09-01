import { privateKeyToAccount } from 'viem/accounts';
import type { LocalAccount } from 'viem';
import type { DeycidConfig } from '../config/env.js';
import { WalletUnavailableError } from '../errors.js';
import type { AgentWalletInfo } from '../types/payment.js';

/**
 * The agent wallet.
 *
 * The private key exists in exactly one place — the `LocalAccount` held
 * privately below — and is never returned, logged, serialized, or put into an
 * error message. `toJSON` is overridden so an accidental
 * `JSON.stringify(wallet)` anywhere cannot leak it either.
 *
 * A viem `LocalAccount` already satisfies x402's `ClientEvmSigner` structural
 * type (it exposes `address` and `signTypedData`), so it is handed to
 * `registerExactEvmScheme` directly rather than being re-wrapped.
 */
export class AgentWallet {
  readonly #account: LocalAccount;
  readonly #network: string;
  readonly #maxPaymentPerCallUsdc: number;

  private constructor(account: LocalAccount, network: string, maxPaymentPerCallUsdc: number) {
    this.#account = account;
    this.#network = network;
    this.#maxPaymentPerCallUsdc = maxPaymentPerCallUsdc;
  }

  /**
   * Builds a wallet from config, or returns `undefined` when no key is set.
   *
   * Returning `undefined` rather than throwing is deliberate: Deycid still
   * serves discovery and case-inspection tools without a wallet, and only
   * refuses at the point a paid call is actually attempted.
   */
  static fromConfig(config: DeycidConfig): AgentWallet | undefined {
    if (!config.agentPrivateKey) return undefined;
    let account: LocalAccount;
    try {
      account = privateKeyToAccount(config.agentPrivateKey);
    } catch {
      // The underlying viem error can echo the key; it is swallowed on purpose.
      throw new WalletUnavailableError(
        'Could not derive an account from AGENT_PRIVATE_KEY. Value withheld from this message.',
      );
    }
    return new AgentWallet(account, config.paymentNetwork, config.maxPaymentPerCallUsdc);
  }

  /** The signer handed to the x402 client. Holds the key; never serialize it. */
  get signer(): LocalAccount {
    return this.#account;
  }

  getAgentAddress(): `0x${string}` {
    return this.#account.address;
  }

  /** `0x1234...abcd`, for demo output. */
  getShortAddress(): string {
    const a = this.#account.address;
    return `${a.slice(0, 6)}...${a.slice(-4)}`;
  }

  /** Safe public metadata. Contains no key material. */
  getInfo(): AgentWalletInfo {
    return {
      address: this.#account.address,
      network: this.#network,
      maxPaymentPerCallUsdc: this.#maxPaymentPerCallUsdc,
    };
  }

  /** Guards against the wallet ever being serialized into a response or log. */
  toJSON(): AgentWalletInfo {
    return this.getInfo();
  }
}

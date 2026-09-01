import type { CaseFacets } from '../types/case.js';
import type { IntentName, ScoringTier } from '../types/telegraph.js';

/**
 * Deycid's working set of Telegraph intents.
 *
 * These are canonical Telegraph intents (verified live against
 * `GET /engine/v1/intents`), not Deycid inventions. Deycid carries a small
 * subset deliberately — the ones that bear on "should this agent execute this
 * on-chain action?" — and this registry is the only place that needs editing to
 * add more.
 *
 * An important protocol detail shapes this file. Telegraph's
 * `POST /engine/v1/ask` does **not** accept an intent: it takes a
 * natural-language `query`, and Telegraph's own LLM router classifies it and
 * picks a miner. Deycid therefore cannot select an intent directly. What it
 * does instead is shape a query that should classify to the intent it wants,
 * then read back the `intent` Telegraph actually routed to. Both are recorded,
 * and a mismatch discounts the evidence rather than being papered over.
 */

/**
 * Which case facts an intent needs before it is worth buying.
 *
 * Every intent must name at least one. There is deliberately no "always
 * applicable" option: an intent that can be bought for any question at all
 * would let Deycid spend money researching a decision it has no purchase on,
 * which is the opposite of what the budget is for.
 */
export type FacetRequirement =
  | 'transactionHash'
  | 'actingAddress'
  | 'address'
  | 'asset'
  | 'url'
  | 'subject'
  | 'chain';

export interface IntentDefinition {
  name: IntentName;
  category:
    | 'ONCHAIN_ANALYTICS'
    | 'FINANCIAL_DATA'
    | 'UTILITIES_SECURITY'
    | 'SEARCH'
    | 'RISK_TRUST';
  /**
   * How Telegraph validators grade this intent. Tier A is graded by WASM exact
   * match against scraped ground truth; Tier B by LLM context plus WASM.
   * Deycid weights Tier A higher because there is one right answer to hit.
   */
  tier: ScoringTier;
  /** What this intent contributes to an execute / do-not-execute decision. */
  contributes: string;
  /** Case facts required for the query to be answerable at all. */
  requires: FacetRequirement[];
  /**
   * How fast this evidence goes stale, in seconds, used by the freshness
   * discount. A price is worthless in minutes; a mined transaction is not.
   */
  halfLifeSeconds: number;
  /**
   * Deycid's baseline relevance for this intent on an on-chain execution
   * decision, 0..1, before facet-specific adjustment. Documented judgement,
   * not a protocol value.
   */
  baseRelevance: number;
  /**
   * Estimated price per call in USDC. Every miner Deycid targets currently
   * declares a floor of 10000 atomic units ($0.01); Telegraph then applies a
   * demand multiplier, so this estimate is padded. Used only for planning —
   * the amount actually paid comes from the x402 challenge.
   */
  estimatedCostUsdc: number;
  /** Builds the natural-language query Deycid sends to the Engine's router. */
  buildQuery: (facets: CaseFacets, decision: string) => string | undefined;
  /** Optional structured hints, merged into the routed request by the Engine. */
  buildContext?: (facets: CaseFacets) => Record<string, unknown> | undefined;
}

const first = (xs: string[]): string | undefined => xs[0];

export const INTENT_REGISTRY: Readonly<Record<IntentName, IntentDefinition>> = Object.freeze({
  ONCHAIN_TX_LOOKUP: {
    name: 'ONCHAIN_TX_LOOKUP',
    category: 'ONCHAIN_ANALYTICS',
    tier: 'A_DETERMINISTIC',
    contributes: 'Whether the referenced transaction exists and what state it settled in.',
    requires: ['transactionHash'],
    halfLifeSeconds: 86_400,
    baseRelevance: 1.0,
    estimatedCostUsdc: 0.015,
    buildQuery: (f) =>
      f.transactionHash
        ? `Look up on-chain transaction ${f.transactionHash} on the ${f.chain ?? 'base'} network. ` +
          `Report its status (success, failed, reverted or pending), sender, recipient and value.`
        : undefined,
    buildContext: (f) =>
      f.transactionHash
        ? { transaction_hash: f.transactionHash, chain: f.chain ?? 'base' }
        : undefined,
  },

  WALLET_BALANCE_CHECK: {
    name: 'WALLET_BALANCE_CHECK',
    category: 'ONCHAIN_ANALYTICS',
    tier: 'A_DETERMINISTIC',
    contributes: 'Whether the acting wallet actually holds the funds the action needs.',
    // Only the ACTING wallet. Asking this about a counterparty contract answers
    // a question nobody asked — a pool holding 0 ETH is entirely normal and
    // says nothing about whether the caller can pay.
    requires: ['actingAddress'],
    halfLifeSeconds: 900,
    baseRelevance: 0.9,
    estimatedCostUsdc: 0.015,
    buildQuery: (f) => {
      const addr = f.actingAddress;
      if (!addr) return undefined;
      // Name the token when it is known. Left unqualified, miners answer with
      // the native balance, which is rarely the asset the decision is about.
      const asset = first(f.assets);
      const what = asset ? `${asset} token balance` : 'native and token balances';
      return `What is the current ${what} of wallet address ${addr} on the ${f.chain ?? 'base'} network?`;
    },
    buildContext: (f) => {
      const addr = f.actingAddress;
      if (!addr) return undefined;
      const asset = first(f.assets);
      return { address: addr, chain: f.chain ?? 'base', ...(asset ? { symbol: asset } : {}) };
    },
  },

  GAS_PRICE: {
    name: 'GAS_PRICE',
    category: 'ONCHAIN_ANALYTICS',
    tier: 'A_DETERMINISTIC',
    contributes: 'Whether network conditions make execution unusually expensive right now.',
    // Gas only bears on a decision that actually touches a chain — an on-chain
    // anchor must be present before this is worth buying.
    requires: ['transactionHash', 'actingAddress', 'address', 'chain'],
    halfLifeSeconds: 300,
    baseRelevance: 0.45,
    estimatedCostUsdc: 0.015,
    buildQuery: (f) => `What is the current gas price on the ${f.chain ?? 'base'} network?`,
    buildContext: (f) => ({ chain: f.chain ?? 'base' }),
  },

  CRYPTO_PRICE: {
    name: 'CRYPTO_PRICE',
    category: 'FINANCIAL_DATA',
    tier: 'A_DETERMINISTIC',
    contributes: 'Whether the asset being moved is priced where the decision assumes it is.',
    requires: ['asset'],
    halfLifeSeconds: 600,
    baseRelevance: 0.75,
    estimatedCostUsdc: 0.015,
    buildQuery: (f) => {
      const asset = first(f.assets);
      return asset ? `What is the current price of ${asset} in USD?` : undefined;
    },
    buildContext: (f) => {
      const asset = first(f.assets);
      return asset ? { symbol: asset } : undefined;
    },
  },

  TVL_LOOKUP: {
    name: 'TVL_LOOKUP',
    category: 'FINANCIAL_DATA',
    tier: 'A_DETERMINISTIC',
    contributes: 'Whether the counterparty protocol still holds meaningful liquidity.',
    requires: ['subject'],
    halfLifeSeconds: 21_600,
    baseRelevance: 0.7,
    estimatedCostUsdc: 0.015,
    buildQuery: (f) => {
      const subject = first(f.subjects);
      return subject
        ? `What is the current total value locked (TVL) of the ${subject} protocol?`
        : undefined;
    },
    buildContext: (f) => {
      const subject = first(f.subjects);
      return subject ? { protocol: subject } : undefined;
    },
  },

  URL_SCAN: {
    name: 'URL_SCAN',
    category: 'UTILITIES_SECURITY',
    tier: 'A_DETERMINISTIC',
    contributes: 'Whether a URL involved in the action is flagged as malicious or a phishing host.',
    requires: ['url'],
    halfLifeSeconds: 43_200,
    baseRelevance: 0.85,
    estimatedCostUsdc: 0.015,
    buildQuery: (f) => {
      const url = first(f.urls);
      return url
        ? `Scan the URL ${url} and report whether it is malicious, a phishing site, or safe.`
        : undefined;
    },
    buildContext: (f) => {
      const url = first(f.urls);
      return url ? { url } : undefined;
    },
  },

  FRAUD_DETECTION: {
    name: 'FRAUD_DETECTION',
    category: 'RISK_TRUST',
    tier: 'B_LLM_JUDGE',
    contributes: 'Whether the counterparty address or protocol carries a known fraud signal.',
    requires: ['address', 'subject'],
    halfLifeSeconds: 43_200,
    baseRelevance: 0.9,
    estimatedCostUsdc: 0.015,
    buildQuery: (f) => {
      const target = first(f.addresses) ?? first(f.subjects);
      return target
        ? `Assess fraud and scam risk for ${target} on the ${f.chain ?? 'base'} network. ` +
            `Report whether it is associated with scams, drains, phishing or blacklisted activity.`
        : undefined;
    },
    buildContext: (f) => {
      const target = first(f.addresses) ?? first(f.subjects);
      return target ? { target, chain: f.chain ?? 'base' } : undefined;
    },
  },

  NEWS_SEARCH: {
    name: 'NEWS_SEARCH',
    category: 'SEARCH',
    tier: 'B_LLM_JUDGE',
    contributes: 'Whether a recent public incident should stop the action.',
    requires: ['subject', 'asset'],
    halfLifeSeconds: 10_800,
    baseRelevance: 0.6,
    estimatedCostUsdc: 0.015,
    buildQuery: (f) => {
      const subject = first(f.subjects) ?? first(f.assets);
      return subject
        ? `Search recent news for ${subject}. Report any hack, exploit, security incident, ` +
            `depeg, insolvency or halt reported in the last 7 days.`
        : undefined;
    },
  },

  RESEARCH_QUERY: {
    name: 'RESEARCH_QUERY',
    category: 'SEARCH',
    tier: 'B_LLM_JUDGE',
    contributes: 'Open-ended background on the counterparty when structured evidence runs out.',
    requires: ['subject', 'asset', 'address'],
    halfLifeSeconds: 86_400,
    baseRelevance: 0.5,
    estimatedCostUsdc: 0.015,
    buildQuery: (f, decision) => {
      const subject = first(f.subjects) ?? first(f.assets) ?? first(f.addresses);
      if (!subject) return undefined;
      return (
        `Research ${subject} in the context of this decision: "${decision}". ` +
        `Report anything that would make executing this action unsafe.`
      );
    },
  },
} satisfies Record<string, IntentDefinition>);

export const SUPPORTED_INTENTS: readonly IntentName[] = Object.freeze(Object.keys(INTENT_REGISTRY));

export function getIntent(name: IntentName): IntentDefinition | undefined {
  return INTENT_REGISTRY[name];
}

/**
 * Whether the case carries the facts this intent needs.
 * `requires` is a disjunction: any one satisfied facet makes the intent usable.
 */
export function facetsSatisfy(def: IntentDefinition, facets: CaseFacets): boolean {
  return def.requires.some((req) => {
    switch (req) {
      case 'transactionHash':
        return Boolean(facets.transactionHash);
      case 'actingAddress':
        return Boolean(facets.actingAddress);
      case 'address':
        return facets.addresses.length > 0;
      case 'asset':
        return facets.assets.length > 0;
      case 'url':
        return facets.urls.length > 0;
      case 'subject':
        return facets.subjects.length > 0;
      case 'chain':
        return Boolean(facets.chain);
      default:
        return false;
    }
  });
}

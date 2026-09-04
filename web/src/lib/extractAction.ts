/**
 * Best-effort field extraction from a visitor's free-text proposed action, for
 * the "Proposed action" display only. It never feeds the engine: the raw text
 * is what's actually sent to /api/run, and Deycid's own fact extraction
 * (src/decision/evidence-strategy.ts) runs independently and far more
 * thoroughly on the server.
 *
 * Deliberately conservative: an allowlist match or nothing. A field that
 * isn't recognized in the text is reported as unset, never guessed.
 *
 * ASSETS and PROTOCOLS are kept identical to the server's KNOWN_ASSETS and
 * KNOWN_SUBJECTS lists (src/decision/evidence-strategy.ts) on purpose — a
 * mismatch here would mean this panel shows "Not specified" for something
 * the engine actually recognized and bought evidence about, which is exactly
 * the kind of confusion this display exists to prevent. AMOUNT and NETWORK
 * have no server-side equivalent (the demo always evaluates against Base
 * regardless of what's typed — see the real Network row in the spec sheet
 * below this panel) and are shown only as a readback of the visitor's own
 * words.
 */

export interface ExtractedAction {
  action: string | null;
  asset: string | null;
  amount: string | null;
  protocol: string | null;
  network: string | null;
}

const ACTION_VERBS: Record<string, string> = {
  deposit: 'Deposit',
  supply: 'Supply',
  withdraw: 'Withdraw',
  borrow: 'Borrow',
  repay: 'Repay',
  swap: 'Swap',
  bridge: 'Bridge',
  stake: 'Stake',
  unstake: 'Unstake',
  transfer: 'Transfer',
  send: 'Send',
  approve: 'Approve',
  claim: 'Claim',
  mint: 'Mint',
  burn: 'Burn',
  lend: 'Lend',
  liquidate: 'Liquidate',
  execute: 'Execute',
  buy: 'Buy',
  sell: 'Sell',
};

/** Mirrors KNOWN_ASSETS in src/decision/evidence-strategy.ts exactly. */
const ASSETS = [
  'BTC', 'WBTC', 'ETH', 'WETH', 'USDC', 'USDT', 'DAI', 'SOL', 'MATIC', 'ARB',
  'OP', 'BASE', 'LINK', 'UNI', 'AAVE', 'CRV', 'LDO', 'MKR', 'SNX', 'COMP',
  'PEPE', 'DEGEN', 'CBETH', 'RETH', 'STETH', 'FRAX', 'GHO', 'TG',
];

/** Mirrors KNOWN_SUBJECTS in src/decision/evidence-strategy.ts exactly, mapped to display casing. */
const PROTOCOLS: Record<string, string> = {
  aave: 'Aave',
  uniswap: 'Uniswap',
  compound: 'Compound',
  curve: 'Curve',
  lido: 'Lido',
  maker: 'MakerDAO',
  makerdao: 'MakerDAO',
  balancer: 'Balancer',
  sushiswap: 'SushiSwap',
  pancakeswap: 'PancakeSwap',
  aerodrome: 'Aerodrome',
  velodrome: 'Velodrome',
  morpho: 'Morpho',
  pendle: 'Pendle',
  eigenlayer: 'EigenLayer',
  gmx: 'GMX',
  synthetix: 'Synthetix',
  yearn: 'Yearn',
  convex: 'Convex',
  frax: 'Frax',
  'rocket pool': 'Rocket Pool',
  seamless: 'Seamless',
  moonwell: 'Moonwell',
  'extra finance': 'Extra Finance',
  baseswap: 'BaseSwap',
};

const NETWORKS: Record<string, string> = {
  base: 'Base',
  ethereum: 'Ethereum',
  mainnet: 'Ethereum',
  arbitrum: 'Arbitrum',
  optimism: 'Optimism',
  polygon: 'Polygon',
  avalanche: 'Avalanche',
  bnb: 'BNB Chain',
  bsc: 'BNB Chain',
  zksync: 'zkSync',
  linea: 'Linea',
  scroll: 'Scroll',
  solana: 'Solana',
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** First (leftmost) match among the dictionary's keys, case-insensitive, whole-word only. */
function firstMatch(text: string, dict: Record<string, string>): string | null {
  const keys = Object.keys(dict).sort((a, b) => b.length - a.length);
  if (keys.length === 0) return null;
  const pattern = new RegExp(`\\b(${keys.map(escapeRegExp).join('|')})\\b`, 'i');
  const m = pattern.exec(text);
  return m ? (dict[m[1]!.toLowerCase()] ?? null) : null;
}

function extractAmount(text: string): string | null {
  const m = /(?<![A-Za-z0-9.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![A-Za-z0-9])/.exec(text);
  return m ? m[1]! : null;
}

export function extractActionFields(text: string): ExtractedAction {
  const assetDict = Object.fromEntries(ASSETS.map((a) => [a.toLowerCase(), a]));
  return {
    action: firstMatch(text, ACTION_VERBS),
    asset: firstMatch(text, assetDict),
    amount: extractAmount(text),
    protocol: firstMatch(text, PROTOCOLS),
    network: firstMatch(text, NETWORKS),
  };
}

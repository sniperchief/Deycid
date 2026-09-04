/**
 * Best-effort field extraction from a visitor's free-text proposed action, for
 * the "Proposed action" display only — purely cosmetic. It never feeds the
 * engine: the raw text is what's actually sent to /api/run, and Deycid's own
 * fact extraction (src/decision/evidence-strategy.ts) runs independently and
 * far more thoroughly on the server.
 *
 * Deliberately conservative: an allowlist match or nothing. A field that
 * isn't recognized in the text is reported as unset, never guessed.
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

const ASSETS = [
  'USDC', 'USDT', 'DAI', 'WETH', 'ETH', 'WBTC', 'BTC', 'WSTETH', 'STETH', 'CBETH',
  'MATIC', 'ARB', 'OP', 'LINK', 'UNI', 'AAVE', 'MORPHO', 'COMP', 'MKR', 'CRV',
  'LDO', 'SNX', 'SUSHI', 'GMX', 'PENDLE', 'RETH', 'USDS', 'EURC', 'FRAX',
];

const PROTOCOLS: Record<string, string> = {
  aave: 'Aave',
  morpho: 'Morpho',
  uniswap: 'Uniswap',
  compound: 'Compound',
  curve: 'Curve',
  balancer: 'Balancer',
  lido: 'Lido',
  makerdao: 'MakerDAO',
  maker: 'MakerDAO',
  spark: 'Spark',
  euler: 'Euler',
  yearn: 'Yearn',
  pendle: 'Pendle',
  gmx: 'GMX',
  dydx: 'dYdX',
  synthetix: 'Synthetix',
  sushiswap: 'SushiSwap',
  sushi: 'SushiSwap',
  pancakeswap: 'PancakeSwap',
  '1inch': '1inch',
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

/**
 * Illustrative numbers for the concept-explainer sections (confidence scale,
 * intelligence budget, evidence matrix) — shown only as a labelled "Example"
 * until a visitor runs a real decision in the Decision Lab, at which point
 * those sections switch to that run's actual receipt. See DecisionRunContext.
 */

export type Stance = 'SUPPORTS' | 'CONTRADICTS' | 'NEUTRAL';

export interface IllustrativeEvidenceRow {
  intent: string;
  finding: string;
  confidence: number;
  cost: number;
  status: 'VERIFIED';
  stance: Stance;
}

export const ILLUSTRATIVE_EVIDENCE: IllustrativeEvidenceRow[] = [
  { intent: 'ONCHAIN_TX_LOOKUP', finding: 'Transaction valid', confidence: 0.97, cost: 0.008, status: 'VERIFIED', stance: 'SUPPORTS' },
  { intent: 'WALLET_BALANCE_CHECK', finding: 'Sufficient balance', confidence: 0.99, cost: 0.006, status: 'VERIFIED', stance: 'SUPPORTS' },
  { intent: 'CRYPTO_PRICE', finding: 'Price within threshold', confidence: 0.91, cost: 0.009, status: 'VERIFIED', stance: 'SUPPORTS' },
  { intent: 'NEWS_SEARCH', finding: 'No adverse signal', confidence: 0.94, cost: 0.008, status: 'VERIFIED', stance: 'SUPPORTS' },
];

export const ILLUSTRATIVE_CONFIDENCE_TARGET = 0.9;
export const ILLUSTRATIVE_CONFIDENCE_FINAL = 0.94;

export const ILLUSTRATIVE_BUDGET = {
  allocated: 0.1,
  spent: 0.031,
  rounds: 2,
  maxRounds: 3,
  requests: 4,
};

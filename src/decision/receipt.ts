import type { DecisionCase } from '../types/case.js';
import type { EvidenceItem } from '../types/evidence.js';
import { caseNumber } from '../utils/ids.js';

/**
 * Decision receipts.
 *
 * A receipt is the auditable record of how a verdict was reached: what was
 * bought, what it cost, what it said, and how the number was derived. Two
 * representations, one source — JSON for machines, Markdown for humans.
 *
 * Labelling rule, enforced throughout: every confidence figure is named
 * "Deycid confidence". Telegraph returns no per-response confidence score, so
 * there is nothing here that could be mistaken for one.
 */

export interface DecisionReceipt {
  caseId: string;
  caseNumber: string;
  decision: string;
  context?: string;
  verdict: string;
  state: string;
  policy: string;
  riskTolerance: string;
  /** Deycid-computed aggregate confidence, 0..1. */
  deycidConfidence: number;
  confidenceTarget: number;
  confidenceBreakdown?: {
    direction: string;
    supportMass: number;
    contradictMass: number;
    contradictionRatio: number;
    materialConflict: boolean;
    agreement: number;
    evidenceStrength: number;
    corroboration: number;
    distinctIntents: number;
    rationale: string[];
  };
  budget: { allocatedUsdc: number; spentUsdc: number; remainingUsdc: number };
  roundsUsed: number;
  maxRounds: number;
  stopReason?: string;
  error?: string;
  evidence: {
    id: string;
    round: number;
    requestedIntent: string;
    routedIntent?: string;
    tier: string;
    status: string;
    stance: string;
    quality: string;
    finding: string;
    matchedSignals: string[];
    deycidConfidence: number;
    reliability: number;
    relevance: number;
    freshness: number;
    weight: number;
    costUsd: number;
    minerName?: string;
    minerId?: string;
    routingReasoning?: string;
    signalHash?: string;
    /** Public Telegraph explorer page for this call, when it was recorded. */
    signalExplorerUrl?: string;
    warnings: string[];
  }[];
  supportingEvidence: string[];
  contradictingEvidence: string[];
  neutralEvidence: string[];
  uncertainEvidence: string[];
  payments: {
    requestId: string;
    requestedIntent: string;
    amountUsdc: number;
    asset: string;
    network: string;
    payer?: string;
    transaction?: string;
    /** Chain explorer link for the settlement transaction, when resolvable. */
    transactionUrl?: string;
    settled: boolean;
    settlementError?: string;
    timestamp: string;
  }[];
  createdAt: string;
  completedAt?: string;
}

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
const usd = (n: number): string => `$${n.toFixed(4)}`;

/**
 * Telegraph's public block explorer. Every paid call is recorded as a Signal
 * and gets a page there, so a receipt can point at third-party proof rather
 * than asking anyone to take Deycid's word for what a miner said.
 *
 * The path is singular — `/signal/{hash}`; `/signals/{hash}` is a 404.
 */
export const TELEGRAPH_EXPLORER = 'https://explorer.telegraphprotocol.com';

export function signalExplorerUrl(signalHash: string): string {
  return `${TELEGRAPH_EXPLORER}/signal/${signalHash}`;
}

/** Chain explorers for settlement transactions, by CAIP-2 network. */
const TX_EXPLORERS: Record<string, string> = {
  'eip155:84532': 'https://sepolia.basescan.org/tx/',
  'eip155:8453': 'https://basescan.org/tx/',
};

/** A link to the settlement transaction, when the network is one we know. */
export function transactionExplorerUrl(network: string, transaction: string): string | undefined {
  const base = TX_EXPLORERS[network];
  return base ? `${base}${transaction}` : undefined;
}

function idsWithStance(evidence: readonly EvidenceItem[], stance: string): string[] {
  return evidence.filter((e) => e.status === 'COLLECTED' && e.stance === stance).map((e) => e.id);
}

export function buildReceipt(c: DecisionCase): DecisionReceipt {
  const a = c.assessment;

  return {
    caseId: c.id,
    caseNumber: caseNumber(c.id),
    decision: c.request.decision,
    ...(c.request.context ? { context: c.request.context } : {}),
    verdict: c.verdict ?? 'ABSTAIN',
    state: c.state,
    policy: c.policyName,
    riskTolerance: c.request.riskTolerance,
    deycidConfidence: a?.confidence ?? 0,
    confidenceTarget: c.request.confidenceThreshold,
    ...(a
      ? {
          confidenceBreakdown: {
            direction: a.direction,
            supportMass: Number(a.supportMass.toFixed(4)),
            contradictMass: Number(a.contradictMass.toFixed(4)),
            contradictionRatio: Number(a.contradictionRatio.toFixed(4)),
            materialConflict: a.materialConflict,
            agreement: Number(a.agreement.toFixed(4)),
            evidenceStrength: Number(a.evidenceStrength.toFixed(4)),
            corroboration: Number(a.corroboration.toFixed(4)),
            distinctIntents: a.distinctIntents,
            rationale: a.rationale,
          },
        }
      : {}),
    budget: {
      allocatedUsdc: c.budget.allocatedUsdc,
      spentUsdc: c.budget.spentUsdc,
      remainingUsdc: c.budget.remainingUsdc,
    },
    roundsUsed: c.roundsUsed,
    maxRounds: c.request.maxRounds,
    ...(c.stopReason ? { stopReason: c.stopReason } : {}),
    ...(c.error ? { error: c.error } : {}),
    evidence: c.evidence.map((e) => ({
      id: e.id,
      round: e.round,
      requestedIntent: e.requestedIntent,
      ...(e.routedIntent ? { routedIntent: e.routedIntent } : {}),
      tier: e.tier,
      status: e.status,
      stance: e.stance,
      quality: e.quality,
      finding: e.finding,
      matchedSignals: e.matchedSignals,
      deycidConfidence: Number(e.deycidConfidence.toFixed(4)),
      reliability: Number(e.reliability.toFixed(4)),
      relevance: Number(e.relevance.toFixed(4)),
      freshness: Number(e.freshness.toFixed(4)),
      weight: Number(e.weight.toFixed(4)),
      costUsd: e.costUsd,
      ...(e.source.minerName ? { minerName: e.source.minerName } : {}),
      ...(e.source.minerId ? { minerId: e.source.minerId } : {}),
      ...(e.source.routingReasoning ? { routingReasoning: e.source.routingReasoning } : {}),
      ...(e.source.signalHash
        ? { signalHash: e.source.signalHash, signalExplorerUrl: signalExplorerUrl(e.source.signalHash) }
        : {}),
      warnings: e.source.warnings,
    })),
    supportingEvidence: idsWithStance(c.evidence, 'SUPPORTS'),
    contradictingEvidence: idsWithStance(c.evidence, 'CONTRADICTS'),
    neutralEvidence: idsWithStance(c.evidence, 'NEUTRAL'),
    uncertainEvidence: idsWithStance(c.evidence, 'UNCERTAIN'),
    payments: c.payments.map((p) => ({
      requestId: p.requestId,
      requestedIntent: p.requestedIntent,
      amountUsdc: p.amountUsdc,
      asset: p.asset,
      network: p.network,
      ...(p.payer ? { payer: p.payer } : {}),
      ...(p.transaction ? { transaction: p.transaction } : {}),
      ...(p.transaction && transactionExplorerUrl(p.network, p.transaction)
        ? { transactionUrl: transactionExplorerUrl(p.network, p.transaction)! }
        : {}),
      settled: p.settled,
      ...(p.settlementError ? { settlementError: p.settlementError } : {}),
      timestamp: p.timestamp,
    })),
    createdAt: c.createdAt,
    ...(c.completedAt ? { completedAt: c.completedAt } : {}),
  };
}

/** Escapes pipes so a miner-supplied string cannot break the Markdown table. */
function cell(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

export function renderReceiptMarkdown(receipt: DecisionReceipt): string {
  const lines: string[] = [];

  lines.push(`## Deycid Decision ${receipt.caseNumber}`);
  lines.push('');
  lines.push(`**Verdict:** ${receipt.verdict}`);
  lines.push('');
  lines.push(
    `**Deycid confidence:** ${pct(receipt.deycidConfidence)} · ` +
      `**Required:** ${pct(receipt.confidenceTarget)} · ` +
      `**Policy:** ${receipt.policy}`,
  );
  lines.push('');
  lines.push(`**State:** \`${receipt.state}\``);
  if (receipt.stopReason) lines.push(`**Stopped because:** ${receipt.stopReason}`);
  lines.push('');

  lines.push('### Decision');
  lines.push('');
  lines.push(receipt.decision);
  lines.push('');

  lines.push('### Evidence');
  lines.push('');
  if (receipt.evidence.length === 0) {
    lines.push('_No intelligence was acquired._');
  } else {
    lines.push('| Round | Intent requested | Routed to | Miner | Finding | Deycid conf. | Stance |');
    lines.push('|---:|---|---|---|---|---:|---|');
    for (const e of receipt.evidence) {
      const routed = e.routedIntent ?? '—';
      const routedCell = e.routedIntent && e.routedIntent !== e.requestedIntent ? `**${routed}**` : routed;
      lines.push(
        `| ${e.round} | ${e.requestedIntent} | ${routedCell} | ${cell(e.minerName ?? '—', 24)} | ` +
          `${cell(e.finding)} | ${pct(e.deycidConfidence)} | ${e.stance} |`,
      );
    }
  }
  lines.push('');

  const b = receipt.confidenceBreakdown;
  if (b) {
    lines.push('### How that confidence was reached');
    lines.push('');
    lines.push(
      `Support mass **${b.supportMass}** vs contradiction mass **${b.contradictMass}** ` +
        `across **${b.distinctIntents}** distinct intent(s).`,
    );
    lines.push('');
    for (const line of b.rationale) lines.push(`- ${line}`);
    if (b.materialConflict) {
      lines.push('');
      lines.push('> **Material conflict detected.** Evidence disagreed beyond the policy tolerance.');
    }
    lines.push('');
  }

  lines.push('### Intelligence economics');
  lines.push('');
  lines.push(`- Budget: ${usd(receipt.budget.allocatedUsdc)}`);
  lines.push(`- Spent: ${usd(receipt.budget.spentUsdc)}`);
  lines.push(`- Remaining: ${usd(receipt.budget.remainingUsdc)}`);
  lines.push(`- Rounds: ${receipt.roundsUsed} of ${receipt.maxRounds}`);
  lines.push(`- Intelligence requests: ${receipt.evidence.length}`);
  lines.push('');

  if (receipt.payments.length > 0) {
    lines.push('### x402 payments');
    lines.push('');
    lines.push('| Intent | Amount | Network | Settlement tx | Settled |');
    lines.push('|---|---:|---|---|---|');
    for (const p of receipt.payments) {
      const tx = p.transaction
        ? p.transactionUrl
          ? `[\`${cell(p.transaction, 18)}\`](${p.transactionUrl})`
          : `\`${cell(p.transaction, 24)}\``
        : '—';
      lines.push(
        `| ${p.requestedIntent} | ${usd(p.amountUsdc)} | ${p.network} | ${tx} | ${p.settled ? 'yes' : 'no'} |`,
      );
    }
    lines.push('');
  }

  const recorded = receipt.evidence.filter((e) => e.signalHash && e.signalExplorerUrl);
  if (recorded.length > 0) {
    lines.push('### Verify this decision');
    lines.push('');
    lines.push(
      'Telegraph records every paid call as a Signal. These are public — anyone can open them ' +
        'and see the request, the miner that answered, the response and the cost, without ' +
        'taking Deycid at its word for any of it:',
    );
    lines.push('');
    for (const e of recorded) {
      lines.push(
        `- **${e.requestedIntent}** — [\`${cell(e.signalHash!, 22)}\`](${e.signalExplorerUrl})`,
      );
    }
    lines.push('');
  }

  if (receipt.error) {
    lines.push('### Error');
    lines.push('');
    lines.push(`\`\`\`\n${receipt.error}\n\`\`\``);
    lines.push('');
  }

  lines.push('---');
  lines.push(
    '_Confidence figures above are **Deycid confidence** — computed by Deycid from observable ' +
      'properties of each Telegraph exchange (scoring tier, routing match, signal recording, ' +
      'warnings, read quality, freshness, corroboration). Telegraph does not return a ' +
      'per-response confidence score._',
  );

  return lines.join('\n');
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DeycidConfig } from '../config/env.js';
import type { CaseManager } from '../decision/case-manager.js';
import { listPolicies } from '../decision/policy-engine.js';
import { buildReceipt, renderReceiptMarkdown } from '../decision/receipt.js';
import { isDeycidError } from '../errors.js';
import type { AgentWallet } from '../payments/wallet.js';
import type { TelegraphClientLike } from '../telegraph/client.js';
import { signalExplorerUrl } from '../decision/receipt.js';
import type { UsageLog } from '../usage/log.js';
import { INTENT_REGISTRY, SUPPORTED_INTENTS } from '../telegraph/intents.js';
import { caseNumber } from '../utils/ids.js';

/**
 * MCP tool surface.
 *
 * Each tool returns both a Markdown block (for a human reading the transcript)
 * and a `structuredContent` object (for an agent consuming the result). Errors
 * are returned as `isError` results carrying a stable code rather than thrown,
 * so a calling agent can branch on them.
 */

interface ToolDeps {
  caseManager: CaseManager;
  telegraph: TelegraphClientLike;
  config: DeycidConfig;
  wallet?: AgentWallet;
  usage?: UsageLog;
}

/** Shapes any thrown value into an MCP error result. Never leaks a stack. */
function errorResult(err: unknown) {
  const code = isDeycidError(err) ? err.code : 'UNEXPECTED_ERROR';
  const message = err instanceof Error ? err.message : String(err);
  const details = isDeycidError(err) ? err.details : {};

  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: `**Deycid error (${code})**\n\n${message}` }],
    structuredContent: { ok: false, code, message, details },
  };
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { caseManager, telegraph, config, wallet, usage } = deps;

  // ── deycid_evaluate_decision ───────────────────────────────────────────────
  server.registerTool(
    'deycid_evaluate_decision',
    {
      title: 'Evaluate a decision against purchased Telegraph intelligence',
      description:
        'Runs Deycid\'s intelligence acquisition loop for a proposed action. Deycid buys verified ' +
        'intelligence from the Telegraph network over x402, round by round, until it reaches its ' +
        'confidence target, exhausts its USDC budget, or runs out of rounds. Returns a verdict ' +
        '(APPROVE / REJECT / ABSTAIN), the evidence matrix, the confidence derivation, budget ' +
        'spent, and real x402 payment proofs. ABSTAIN means the bar was not met and the action ' +
        'should NOT be executed. Each call spends real USDC on the configured network.',
      inputSchema: {
        decision: z
          .string()
          .min(8)
          .describe('The proposed action, phrased as a question. e.g. "Should I execute this transaction?"'),
        context: z
          .string()
          .optional()
          .describe('Free text with any further detail: addresses, protocol names, amounts, URLs.'),
        chain: z.string().optional().describe('Chain the action targets, e.g. "base".'),
        transactionHash: z
          .string()
          .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte hex string')
          .optional()
          .describe('Transaction hash to investigate, if the decision concerns one.'),
        actingAddress: z
          .string()
          .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte hex address')
          .optional()
          .describe(
            'The wallet that would EXECUTE the action. Distinct from counterparty addresses ' +
              'in `context`: balance checks run against this one, risk checks against those. ' +
              'Without it Deycid will not buy a balance check at all.',
          ),
        riskTolerance: z
          .enum(['low', 'medium', 'high'])
          .optional()
          .describe(
            'Appetite for acting on thin evidence. "low" demands the most confidence. Default "medium".',
          ),
        confidenceThreshold: z
          .number()
          .min(0.01)
          .max(0.99)
          .optional()
          .describe('Override the policy confidence target, 0..1.'),
        intelligenceBudgetUsdc: z
          .number()
          .positive()
          .max(100)
          .optional()
          .describe('Hard USDC ceiling on intelligence for this case. Capped by the policy.'),
        maxRounds: z.number().int().min(1).max(10).optional().describe('Maximum evidence rounds.'),
      },
    },
    async (args, extra) => {
      try {
        // A multi-round evaluation can outlast an MCP client's default 60s
        // request timeout — a live run was cut off at exactly that. Progress
        // notifications let a client extend its deadline and show the user what
        // Deycid is buying meanwhile. Only sent when the client asked for them
        // by supplying a progress token.
        const progressToken = extra?._meta?.progressToken;
        const onProgress =
          progressToken !== undefined
            ? (update: { completed: number; round: number; message: string }) => {
                void extra
                  .sendNotification({
                    method: 'notifications/progress',
                    params: {
                      progressToken,
                      progress: update.completed,
                      message: update.message,
                    },
                  })
                  .catch(() => {
                    // Advisory only; never fail a decision over a notification.
                  });
              }
            : undefined;

        const decisionCase = await caseManager.evaluate({
          decision: args.decision,
          ...(args.context !== undefined ? { context: args.context } : {}),
          ...(args.chain !== undefined ? { chain: args.chain } : {}),
          ...(args.transactionHash !== undefined ? { transactionHash: args.transactionHash } : {}),
          ...(args.actingAddress !== undefined ? { actingAddress: args.actingAddress } : {}),
          ...(args.riskTolerance !== undefined ? { riskTolerance: args.riskTolerance } : {}),
          ...(args.confidenceThreshold !== undefined
            ? { confidenceThreshold: args.confidenceThreshold }
            : {}),
          ...(args.intelligenceBudgetUsdc !== undefined
            ? { intelligenceBudgetUsdc: args.intelligenceBudgetUsdc }
            : {}),
          ...(args.maxRounds !== undefined ? { maxRounds: args.maxRounds } : {}),
        }, onProgress);

        const receipt = buildReceipt(decisionCase);
        return {
          content: [{ type: 'text' as const, text: renderReceiptMarkdown(receipt) }],
          structuredContent: { ok: true, receipt } as Record<string, unknown>,
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── deycid_case_status ─────────────────────────────────────────────────────
  server.registerTool(
    'deycid_case_status',
    {
      title: 'Read the current state of a Deycid decision case',
      description:
        'Returns the full decision receipt for a case created earlier in this server process, ' +
        'including its state, evidence, confidence derivation and payments. Cases are held in ' +
        'memory and do not survive a restart.',
      inputSchema: {
        caseId: z.string().min(1).describe('Case id, e.g. "case-1042".'),
      },
    },
    async ({ caseId }) => {
      try {
        const decisionCase = caseManager.getCase(caseId);
        const receipt = buildReceipt(decisionCase);
        return {
          content: [{ type: 'text' as const, text: renderReceiptMarkdown(receipt) }],
          structuredContent: { ok: true, receipt } as Record<string, unknown>,
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── deycid_network_status ──────────────────────────────────────────────────
  server.registerTool(
    'deycid_network_status',
    {
      title: 'Deycid and Telegraph network status',
      description:
        'Reports the intents Deycid is configured to buy alongside their live Telegraph miner ' +
        'counts, the agent wallet address and payment network, and telemetry for the cases this ' +
        'server process has actually run. Reads the live Telegraph node; requires no payment.',
      inputSchema: {},
    },
    async () => {
      try {
        const telemetry = caseManager.getTelemetry();

        // Live miner counts, best effort. Discovery is free, but the node being
        // unreachable must not make status itself fail.
        let liveIntents: { intent: string; minerCount?: number; description?: string }[] = [];
        let discoveryError: string | undefined;
        try {
          const available = await telegraph.getAvailableIntents();
          const byName = new Map(available.map((i) => [i.intent_name, i]));
          liveIntents = SUPPORTED_INTENTS.map((name) => {
            const live = byName.get(name);
            return {
              intent: name,
              ...(live?.miner_count !== undefined ? { minerCount: live.miner_count } : {}),
              ...(live?.description ? { description: live.description } : {}),
            };
          });
        } catch (err) {
          discoveryError = err instanceof Error ? err.message : String(err);
          liveIntents = SUPPORTED_INTENTS.map((name) => ({ intent: name }));
        }

        const recentCases = caseManager
          .listCases()
          .slice(-5)
          .map((c) => ({
            caseId: c.id,
            state: c.state,
            verdict: c.verdict ?? null,
            deycidConfidence: c.assessment ? Number(c.assessment.confidence.toFixed(4)) : null,
            spentUsdc: c.budget.spentUsdc,
            rounds: c.roundsUsed,
          }));

        const structured = {
          ok: true,
          deycid: {
            configuredIntents: SUPPORTED_INTENTS.length,
            paymentsEnabled: telegraph.canPay(),
            policies: listPolicies().map((p) => ({
              name: p.name,
              riskTolerance: p.riskTolerance,
              confidenceTarget: p.confidenceTarget,
              maxContradictionRatio: p.maxContradictionRatio,
              maxIntelligenceBudgetUsdc: p.maxIntelligenceBudgetUsdc,
              maxRounds: p.maxRounds,
            })),
          },
          wallet: wallet ? wallet.getInfo() : null,
          telegraph: {
            nodeUrl: config.telegraphNodeUrl,
            engineUrl: config.telegraphEngineUrl,
            paymentNetwork: config.paymentNetwork,
            intents: liveIntents,
            ...(discoveryError ? { discoveryError } : {}),
          },
          telemetry,
          recentCases,
        };

        const lines: string[] = [];
        lines.push('## Deycid network status');
        lines.push('');
        lines.push(`**Telegraph node:** \`${config.telegraphNodeUrl}\``);
        lines.push(`**Payment network:** \`${config.paymentNetwork}\``);
        lines.push(
          `**Agent wallet:** ${wallet ? `\`${wallet.getAgentAddress()}\` (${wallet.getShortAddress()})` : '_not configured — paid intelligence disabled_'}`,
        );
        if (wallet) lines.push(`**Per-call ceiling:** $${wallet.getInfo().maxPaymentPerCallUsdc}`);
        lines.push('');

        lines.push('### Configured intents (live Telegraph miner counts)');
        lines.push('');
        lines.push('| Intent | Tier | Live miners | Contributes |');
        lines.push('|---|---|---:|---|');
        for (const entry of liveIntents) {
          const def = INTENT_REGISTRY[entry.intent];
          lines.push(
            `| ${entry.intent} | ${def?.tier ?? '—'} | ${entry.minerCount ?? '—'} | ${def?.contributes ?? '—'} |`,
          );
        }
        if (discoveryError) {
          lines.push('');
          lines.push(`> Live miner counts unavailable: ${discoveryError}`);
        }
        lines.push('');

        lines.push('### This process');
        lines.push('');
        lines.push(`- Cases: ${telemetry.totalCases} (${telemetry.activeCases} active)`);
        lines.push(
          `- Intelligence requests: ${telemetry.totalIntelligenceRequests} ` +
            `(${telemetry.failedIntelligenceRequests} failed)`,
        );
        lines.push(`- Total spent: $${telemetry.totalSpentUsdc.toFixed(4)}`);
        lines.push(
          `- Average Deycid confidence: ${
            telemetry.averageConfidence === null ? '—' : `${(telemetry.averageConfidence * 100).toFixed(0)}%`
          }`,
        );
        lines.push(`- Average rounds per case: ${telemetry.averageRoundsPerCase ?? '—'}`);
        lines.push(
          `- Verdicts: ${telemetry.verdictCounts.APPROVE} approve, ` +
            `${telemetry.verdictCounts.REJECT} reject, ${telemetry.verdictCounts.ABSTAIN} abstain`,
        );
        lines.push('');

        if (recentCases.length > 0) {
          lines.push('### Recent cases');
          lines.push('');
          lines.push('| Case | State | Verdict | Deycid conf. | Spent | Rounds |');
          lines.push('|---|---|---|---:|---:|---:|');
          for (const c of recentCases) {
            lines.push(
              `| ${caseNumber(c.caseId)} | \`${c.state}\` | ${c.verdict ?? '—'} | ` +
                `${c.deycidConfidence === null ? '—' : `${(c.deycidConfidence * 100).toFixed(0)}%`} | ` +
                `$${c.spentUsdc.toFixed(4)} | ${c.rounds} |`,
            );
          }
          lines.push('');
        }

        lines.push(
          '_Telemetry covers only cases this server process has run. Miner counts come live from ' +
            'Telegraph\'s `/engine/v1/intents`._',
        );

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: structured as Record<string, unknown>,
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── deycid_usage_report ────────────────────────────────────────────────────
  server.registerTool(
    'deycid_usage_report',
    {
      title: 'Verifiable report of this installation\'s Telegraph usage',
      description:
        'Summarises the Telegraph calls this Deycid installation has paid for: how many, what ' +
        'they cost, which intents, and the Signal hashes that prove it. Telegraph keys Signals ' +
        'to the paying wallet and offers no public way to list them per wallet, so a self-hosted ' +
        'application has to keep this record itself. The log is written to a local file only and ' +
        'is never transmitted by Deycid — sharing a report is always your choice. Set ' +
        'DEYCID_USAGE_LOG=off to disable recording entirely.',
      inputSchema: {},
    },
    async () => {
      try {
        const summary = usage?.summarise() ?? {
          enabled: false,
          totalCalls: 0,
          totalSpentUsdc: 0,
          distinctCases: 0,
          wallets: [],
          byIntent: {},
          signalHashes: [],
        };

        const lines: string[] = ['## Deycid usage report', ''];

        if (!summary.enabled) {
          lines.push('_Usage recording is disabled (`DEYCID_USAGE_LOG=off`)._');
          return {
            content: [{ type: 'text' as const, text: lines.join('\n') }],
            structuredContent: { ok: true, usage: summary } as Record<string, unknown>,
          };
        }

        lines.push(`**Telegraph calls paid for:** ${summary.totalCalls}`);
        lines.push(`**Total spent:** $${summary.totalSpentUsdc.toFixed(4)}`);
        lines.push(`**Decision cases:** ${summary.distinctCases}`);
        if (summary.firstAt) lines.push(`**Period:** ${summary.firstAt} to ${summary.lastAt}`);
        if (summary.wallets.length > 0) lines.push(`**Paying wallet(s):** ${summary.wallets.join(', ')}`);
        lines.push('');

        const intents = Object.entries(summary.byIntent).sort((a, b) => b[1] - a[1]);
        if (intents.length > 0) {
          lines.push('| Intent | Calls |');
          lines.push('|---|---:|');
          for (const [intent, n] of intents) lines.push(`| ${intent} | ${n} |`);
          lines.push('');
        }

        if (summary.signalHashes.length > 0) {
          const shown = summary.signalHashes.slice(-20);
          lines.push(`### Verifiable Signals (${shown.length} most recent of ${summary.signalHashes.length})`);
          lines.push('');
          lines.push('Each is a public Telegraph record of a real paid call:');
          lines.push('');
          for (const h of shown) lines.push(`- ${signalExplorerUrl(h)}`);
          lines.push('');
        }

        if (summary.error) lines.push(`> Log could not be read in full: ${summary.error}`);
        lines.push('');
        lines.push(`_Recorded locally at \`${summary.path}\`. Deycid never transmits this._`);

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: { ok: true, usage: summary } as Record<string, unknown>,
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

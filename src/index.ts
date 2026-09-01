#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, loadEnvFiles } from './config/env.js';
import { CaseManager } from './decision/case-manager.js';
import { isDeycidError } from './errors.js';
import { registerTools } from './mcp/tools.js';
import { X402PayFetch } from './payments/x402-client.js';
import { AgentWallet } from './payments/wallet.js';
import { TelegraphClient } from './telegraph/client.js';
import { SUPPORTED_INTENTS } from './telegraph/intents.js';
import { demo, logger } from './utils/logger.js';

/**
 * Deycid MCP server.
 *
 * Speaks MCP over stdio, so stdout carries JSON-RPC frames and nothing else —
 * all logging goes to stderr (see utils/logger.ts).
 *
 * Startup order matters: configuration is validated first and the process
 * refuses to start on a bad one. A *missing* wallet is not a bad configuration
 * — the server still starts and serves discovery and case inspection, and only
 * refuses when a paid call is actually attempted. That way an operator can
 * inspect the tool surface before funding anything.
 */
async function main(): Promise<void> {
  // Read .env.local / .env before validating. Anything already in the real
  // environment — an MCP client's `env` block, say — takes precedence.
  const envFiles = loadEnvFiles();
  const config = loadConfig();

  const wallet = AgentWallet.fromConfig(config);
  const payFetch = wallet ? new X402PayFetch(wallet, config) : undefined;
  const telegraph = new TelegraphClient(config, payFetch);

  const caseManager = new CaseManager(telegraph, {
    // Omitted when unset, so the risk policy's own band applies.
    ...(config.defaultConfidenceThreshold !== undefined
      ? { confidenceThreshold: config.defaultConfidenceThreshold }
      : {}),
    intelligenceBudgetUsdc: config.defaultIntelligenceBudgetUsdc,
    maxRounds: config.defaultMaxRounds,
  });

  const server = new McpServer(
    { name: 'deycid', version: '0.1.0' },
    {
      instructions:
        'Deycid buys verified intelligence from the Telegraph network until a proposed action ' +
        'reaches a required confidence threshold, or its USDC budget runs out. Call ' +
        'deycid_evaluate_decision before executing a consequential on-chain action. A verdict of ' +
        'ABSTAIN means the evidence bar was not met — do not execute. Every confidence figure ' +
        'Deycid reports is computed by Deycid, not returned by Telegraph.',
    },
  );

  registerTools(server, {
    caseManager,
    telegraph,
    config,
    ...(wallet ? { wallet } : {}),
  });

  logger.info('config.loaded', {
    // File names only — never their contents.
    envFilesLoaded: envFiles.length > 0 ? envFiles : 'none',
    telegraphNodeUrl: config.telegraphNodeUrl,
    telegraphEngineUrl: config.telegraphEngineUrl,
    paymentNetwork: config.paymentNetwork,
    requestTimeoutMs: config.requestTimeoutMs,
    maxPaymentPerCallUsdc: config.maxPaymentPerCallUsdc,
    configuredIntents: SUPPORTED_INTENTS.length,
    paymentsEnabled: wallet !== undefined,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('server.started', { transport: 'stdio', tools: 3 });
  demo(`Deycid MCP server ready — ${SUPPORTED_INTENTS.length} intents configured`);
  if (wallet) {
    demo(`Agent wallet: ${wallet.getAgentAddress()}`);
    demo(`Paying on ${config.paymentNetwork}, ceiling $${config.maxPaymentPerCallUsdc}/call`);
  } else {
    demo('No AGENT_PRIVATE_KEY set — discovery works, paid intelligence is disabled.');
  }

  const shutdown = (signal: string) => {
    demo(`Received ${signal}, shutting down.`);
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  // Startup failures are fatal and must be legible without a debugger — but
  // still must not echo anything sensitive, so only the shaped message is used.
  const code = isDeycidError(err) ? err.code : 'STARTUP_FAILED';
  const message = err instanceof Error ? err.message : String(err);
  logger.error('decision.failed', { phase: 'startup', code, error: message });
  process.stderr.write(`\n[Deycid] Fatal (${code}): ${message}\n`);
  process.exit(1);
});

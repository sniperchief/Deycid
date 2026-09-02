import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadConfig, loadEnvFiles } from '../config/env.js';
import { CaseManager } from '../decision/case-manager.js';
import { buildReceipt } from '../decision/receipt.js';
import { isDeycidError } from '../errors.js';
import { AgentWallet } from '../payments/wallet.js';
import { X402PayFetch } from '../payments/x402-client.js';
import { TelegraphClient } from '../telegraph/client.js';
import { UsageLog } from '../usage/log.js';
import { demo, logger } from '../utils/logger.js';
import { DEFAULT_WEB_LIMITS, visitorKey, WebGuards, type WebLimits } from './guards.js';

/**
 * Public demo server.
 *
 * Deycid's product is the MCP server; this exists so somebody can watch it work
 * without installing Node, editing a client config, and funding a wallet first.
 * It is a thin layer over exactly the same engine — no separate code path, no
 * simulated data. Every run buys real intelligence from real Telegraph miners.
 *
 * It pays from the operator's wallet, so it is written defensively: three
 * independent spend brakes (see guards.ts), a small fixed set of demo scenarios
 * rather than arbitrary free-text spending, and a per-run budget well under the
 * MCP default.
 */

const PORT = Number(process.env.DEYCID_WEB_PORT ?? 8080);

/** Kept in sync with the CaseManager default and the per-run override below — see /api/status. */
const DEMO_MAX_ROUNDS = 3;

const HTML = readFileSync(fileURLToPath(new URL('./public/index.html', import.meta.url)), 'utf8');

/**
 * Fixed demo scenarios.
 *
 * Free-text would let a visitor spend the wallet on anything, and most
 * off-topic questions produce UNCERTAIN evidence that shows Deycid badly. These
 * are real decisions against real on-chain subjects; the `context` is what the
 * MCP tool would receive.
 *
 * Each carries a contract address AND the protocol's real front-end, because
 * the facts in the context decide how many distinct intents Deycid can buy.
 * Without a URL only six unlock, and a third round has no new evidence left to
 * find — it re-asks intents it already bought, sometimes hitting the same miner
 * twice, which is not independent corroboration. A URL unlocks URL_SCAN, a
 * deterministic check that is also exactly what a careful agent should run
 * before approving an interaction with a front-end.
 */
export const SCENARIOS = [
  {
    id: 'aave-supply',
    label: 'Supply USDC to Aave v3 on Base',
    decision: 'Should I supply USDC to the Aave v3 lending pool on Base?',
    context:
      'The Aave v3 Pool contract on Base is 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5, ' +
      'accessed through https://app.aave.com',
    chain: 'base',
  },
  {
    id: 'uniswap-swap',
    label: 'Swap ETH for USDC on Uniswap',
    decision: 'Should I swap ETH for USDC on Uniswap on Base right now?',
    context: 'Swapping through Uniswap on Base, accessed through https://app.uniswap.org',
    chain: 'base',
  },
  {
    id: 'morpho-deposit',
    label: 'Deposit into Morpho on Base',
    decision: 'Should I deposit USDC into the Morpho lending protocol on Base?',
    context: 'Evaluating Morpho as a venue for USDC yield on Base, via https://app.morpho.org',
    chain: 'base',
  },
] as const;

const RunRequestSchema = z.object({
  scenario: z.string().min(1),
  riskTolerance: z.enum(['low', 'medium', 'high']).optional(),
});

/**
 * Reflects the request's Origin so the frontend can be deployed separately
 * from this server (e.g. static site on Vercel, this server on Railway).
 * Credentials are never used here — no cookies, no browser-managed auth — so
 * echoing any origin is no weaker than the CORS-spec `*` wildcard. Real
 * protection against abuse is the spend guards in guards.ts, not this.
 */
function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (!origin) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
}

function send(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

/** Reads a bounded JSON body. Anything oversized is refused rather than buffered. */
async function readBody(req: IncomingMessage, maxBytes = 4096): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export async function startWebServer(): Promise<void> {
  loadEnvFiles();
  const config = loadConfig();

  const wallet = AgentWallet.fromConfig(config);
  if (!wallet) {
    throw new Error(
      'The demo server pays for every run, so AGENT_PRIVATE_KEY must be set. ' +
        'Run the MCP server instead if you only need discovery.',
    );
  }

  const limits: WebLimits = {
    perRequestUsdc: Number(process.env.DEYCID_WEB_PER_REQUEST_BUDGET_USDC ?? DEFAULT_WEB_LIMITS.perRequestUsdc),
    dailyUsdc: Number(process.env.DEYCID_WEB_DAILY_BUDGET_USDC ?? DEFAULT_WEB_LIMITS.dailyUsdc),
    perVisitorPerHour: Number(
      process.env.DEYCID_WEB_RATE_LIMIT_PER_HOUR ?? DEFAULT_WEB_LIMITS.perVisitorPerHour,
    ),
  };
  for (const [k, v] of Object.entries(limits)) {
    if (!Number.isFinite(v) || v <= 0) throw new Error(`Invalid web limit ${k}: ${String(v)}`);
  }

  const guards = new WebGuards(limits);
  const telegraph = new TelegraphClient(config, new X402PayFetch(wallet, config));
  const usage = UsageLog.fromEnv();
  const caseManager = new CaseManager(
    telegraph,
    { intelligenceBudgetUsdc: limits.perRequestUsdc, maxRounds: DEMO_MAX_ROUNDS },
    usage,
  );

  setInterval(() => guards.prune(), 600_000).unref();

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      logger.error('decision.failed', {
        phase: 'web',
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/' && req.method === 'GET') {
      return send(res, 200, HTML, 'text/html; charset=utf-8');
    }

    if (url.pathname === '/api/status' && req.method === 'GET') {
      return sendJson(res, 200, {
        scenarios: SCENARIOS.map((s) => ({ id: s.id, label: s.label })),
        agentAddress: wallet!.getAgentAddress(),
        network: config.paymentNetwork,
        limits,
        maxRounds: DEMO_MAX_ROUNDS,
        spentToday: guards.spentToday(),
        remainingToday: guards.remainingToday(),
      });
    }

    if (url.pathname === '/api/run' && req.method === 'POST') {
      return runScenario(req, res);
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  /** Runs one demo decision, streaming progress as Server-Sent Events. */
  async function runScenario(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const visitor = visitorKey(req.headers, req.socket.remoteAddress ?? undefined);

    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: 'invalid request body' });
    }

    const parsed = RunRequestSchema.safeParse(body);
    if (!parsed.success) return sendJson(res, 400, { error: 'invalid request' });

    const scenario = SCENARIOS.find((s) => s.id === parsed.data.scenario);
    if (!scenario) return sendJson(res, 400, { error: 'unknown scenario' });

    const gate = guards.check(visitor);
    if (!gate.allowed) {
      return sendJson(res, gate.reason === 'RATE_LIMITED' ? 429 : 503, {
        error: gate.reason,
        message: gate.message,
        ...(gate.retryAfterSeconds ? { retryAfterSeconds: gate.retryAfterSeconds } : {}),
      });
    }
    guards.recordStart(visitor);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const emit = (event: string, data: unknown): void => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': keep-alive\n\n');
    }, 15_000);

    emit('start', {
      decision: scenario.decision,
      budgetUsdc: limits.perRequestUsdc,
      riskTolerance: parsed.data.riskTolerance ?? 'medium',
    });

    try {
      const decisionCase = await caseManager.evaluate(
        {
          decision: scenario.decision,
          context: scenario.context,
          chain: scenario.chain,
          riskTolerance: parsed.data.riskTolerance ?? 'medium',
          intelligenceBudgetUsdc: limits.perRequestUsdc,
          maxRounds: DEMO_MAX_ROUNDS,
        },
        (update) => emit('progress', update),
      );

      guards.recordSpend(decisionCase.budget.spentUsdc);
      const receipt = buildReceipt(decisionCase);
      emit('done', { receipt, remainingToday: guards.remainingToday() });

      logger.info('decision.completed', {
        phase: 'web',
        caseId: decisionCase.id,
        verdict: decisionCase.verdict,
        spentUsdc: decisionCase.budget.spentUsdc,
      });
    } catch (err) {
      const code = isDeycidError(err) ? err.code : 'UNEXPECTED_ERROR';
      emit('failed', {
        code,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`Port ${PORT} is already in use. Set DEYCID_WEB_PORT to a free port.`)
          : err,
      );
    });
    server.listen(PORT, resolve);
  });

  demo(`Demo server on http://localhost:${PORT}`);
  demo(`Paying from ${wallet.getAgentAddress()} on ${config.paymentNetwork}`);
  demo(
    `Caps: $${limits.perRequestUsdc}/run, $${limits.dailyUsdc}/day, ` +
      `${limits.perVisitorPerHour} runs/hour/visitor`,
  );

  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

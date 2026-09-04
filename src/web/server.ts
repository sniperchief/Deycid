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
 * independent spend brakes (see guards.ts) — a per-run budget, a per-visitor
 * hourly rate limit, and a hard daily ceiling — plus a length cap on the
 * decision text itself. Those are what actually protect the wallet; a visitor
 * may propose any action in their own words, same as the MCP tool does.
 */

const PORT = Number(process.env.DEYCID_WEB_PORT ?? 8080);

/** Kept in sync with the CaseManager default and the per-run override below — see /api/status. */
const DEMO_MAX_ROUNDS = 3;

/** All demo runs are evaluated against Base — see the network note in the README. */
const DEMO_CHAIN = 'base';

const HTML = readFileSync(fileURLToPath(new URL('./public/index.html', import.meta.url)), 'utf8');

const RunRequestSchema = z.object({
  // CaseManager itself requires >=8 chars; the upper bound just keeps a demo
  // run to one decision statement rather than an arbitrary essay.
  decision: z.string().trim().min(8).max(400),
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
        agentAddress: wallet!.getAgentAddress(),
        network: config.paymentNetwork,
        limits,
        maxRounds: DEMO_MAX_ROUNDS,
        spentToday: guards.spentToday(),
        remainingToday: guards.remainingToday(),
      });
    }

    if (url.pathname === '/api/run' && req.method === 'POST') {
      return runEvaluation(req, res);
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  /** Runs one visitor-proposed decision, streaming progress as Server-Sent Events. */
  async function runEvaluation(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const visitor = visitorKey(req.headers, req.socket.remoteAddress ?? undefined);

    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: 'invalid request body' });
    }

    const parsed = RunRequestSchema.safeParse(body);
    if (!parsed.success) return sendJson(res, 400, { error: 'invalid request' });

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
      decision: parsed.data.decision,
      budgetUsdc: limits.perRequestUsdc,
      riskTolerance: parsed.data.riskTolerance ?? 'medium',
    });

    try {
      const decisionCase = await caseManager.evaluate(
        {
          decision: parsed.data.decision,
          chain: DEMO_CHAIN,
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

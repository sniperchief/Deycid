/**
 * Client for the real Deycid demo server (`src/web/server.ts`).
 *
 * There is no mock layer here — `/api/status` and `/api/run` are the same
 * endpoints the Node server has always exposed, backed by the same engine
 * that runs behind the MCP tool. A run buys real intelligence from real
 * Telegraph miners and pays for it with real USDC from the operator's wallet.
 */

export interface WebLimits {
  perRequestUsdc: number;
  dailyUsdc: number;
  perVisitorPerHour: number;
}

export interface StatusResponse {
  agentAddress: string;
  network: string;
  limits: WebLimits;
  maxRounds: number;
  spentToday: number;
  remainingToday: number;
}

export type RiskTolerance = 'low' | 'medium' | 'high';

/** Mirrors the confidence-target bands in src/decision/policy-engine.ts. */
export const RISK_CONFIDENCE_TARGET: Record<RiskTolerance, number> = {
  low: 0.95,
  medium: 0.9,
  high: 0.8,
};

const NETWORK_LABELS: Record<string, string> = {
  'eip155:8453': 'Base',
  'eip155:84532': 'Base Sepolia',
};

export function networkLabel(caip2: string): string {
  return NETWORK_LABELS[caip2] ?? caip2;
}

export interface EvidenceRow {
  id: string;
  requestedIntent: string;
  finding: string;
  deycidConfidence: number;
  costUsd: number;
  stance: string;
  minerName?: string;
  signalExplorerUrl?: string;
}

export interface DecisionReceipt {
  verdict: string;
  policy: string;
  riskTolerance: string;
  deycidConfidence: number;
  confidenceTarget: number;
  budget: { allocatedUsdc: number; spentUsdc: number; remainingUsdc: number };
  roundsUsed: number;
  maxRounds: number;
  stopReason?: string;
  evidence: EvidenceRow[];
}

export interface ProgressEvent {
  completed: number;
  round: number;
  message: string;
}

export interface RunHandlers {
  onStart?: (data: { decision: string; budgetUsdc: number; riskTolerance: string }) => void;
  onProgress?: (data: ProgressEvent) => void;
  onFailed?: (data: { code: string; message: string }) => void;
  onDone?: (data: { receipt: DecisionReceipt; remainingToday: number }) => void;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/**
 * Base URL of the demo API.
 *
 * Empty string means same-origin — correct when this page is served by
 * src/web/server.ts itself. Set VITE_API_BASE_URL at build time when the
 * frontend is deployed separately from the backend (e.g. this static site on
 * Vercel, the server on Railway).
 */
const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

export async function fetchStatus(): Promise<StatusResponse> {
  const res = await fetch(`${API_BASE}/api/status`);
  if (!res.ok) throw new ApiError('Could not reach the demo server.', res.status);
  return (await res.json()) as StatusResponse;
}

/**
 * Runs one visitor-proposed decision, streaming progress as Server-Sent Events.
 *
 * EventSource cannot POST, so the SSE frame syntax is parsed by hand from a
 * fetch() ReadableStream — the same approach the previous single-file demo
 * page used.
 */
export async function runDecision(
  input: { decision: string; riskTolerance: RiskTolerance },
  handlers: RunHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });

  if (!res.ok || !res.body) {
    let message = 'Request refused.';
    let retryAfterSeconds: number | undefined;
    try {
      const body = (await res.json()) as { message?: string; error?: string; retryAfterSeconds?: number };
      message = body.message ?? body.error ?? message;
      retryAfterSeconds = body.retryAfterSeconds;
    } catch {
      // Non-JSON error body — fall back to the generic message.
    }
    throw new ApiError(message, res.status, retryAfterSeconds);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      let event: string | null = null;
      let data: string | null = null;
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice('event: '.length);
        else if (line.startsWith('data: ')) data = line.slice('data: '.length);
      }
      if (!event || !data) continue;
      const parsed = JSON.parse(data);
      if (event === 'start') handlers.onStart?.(parsed);
      else if (event === 'progress') handlers.onProgress?.(parsed);
      else if (event === 'failed') handlers.onFailed?.(parsed);
      else if (event === 'done') handlers.onDone?.(parsed);
    }
  }
}

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DeycidConfig } from '../src/config/env.js';
import { CaseManager } from '../src/decision/case-manager.js';
import { registerTools } from '../src/mcp/tools.js';
import { __resetCaseCounterForTests } from '../src/utils/ids.js';
import { setLogLevel } from '../src/utils/logger.js';
import { MockTelegraphClient, OK_BALANCE, OK_TX } from './helpers/mock-telegraph.js';

/**
 * Exercises the MCP surface end to end through a real client/server pair over
 * an in-memory transport — the same code path a Claude Desktop or Cursor
 * session takes, minus the process boundary.
 */

const TX = `0x${'a'.repeat(64)}`;
const ADDR = `0x${'b'.repeat(40)}`;

setLogLevel('error');

const CONFIG: DeycidConfig = {
  telegraphNodeUrl: 'https://devnode.telegraphprotocol.com',
  telegraphEngineUrl: 'https://devnode.telegraphprotocol.com/engine',
  paymentNetwork: 'eip155:84532',
  requestTimeoutMs: 45_000,
  maxPaymentPerCallUsdc: 0.05,
  defaultIntelligenceBudgetUsdc: 0.1,
  defaultMaxRounds: 3,
  logLevel: 'error',
};

async function connect(mock: MockTelegraphClient): Promise<Client> {
  const server = new McpServer({ name: 'deycid', version: '0.1.0' });
  registerTools(server, {
    caseManager: new CaseManager(mock, {
      intelligenceBudgetUsdc: CONFIG.defaultIntelligenceBudgetUsdc,
      maxRounds: CONFIG.defaultMaxRounds,
    }),
    telegraph: mock,
    config: CONFIG,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

function structuredOf(result: unknown): Record<string, unknown> {
  return ((result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {}) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  __resetCaseCounterForTests();
});

describe('MCP tool registration', () => {
  it('advertises all four Deycid tools with input schemas', async () => {
    const client = await connect(new MockTelegraphClient().fallback({ result: OK_TX }));
    const { tools } = await client.listTools();

    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'deycid_case_status',
      'deycid_evaluate_decision',
      'deycid_network_status',
      'deycid_usage_report',
    ]);

    const evaluate = tools.find((t) => t.name === 'deycid_evaluate_decision')!;
    expect(evaluate.inputSchema.type).toBe('object');
    expect(Object.keys(evaluate.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining([
        'decision',
        'context',
        'chain',
        'transactionHash',
        'actingAddress',
        'riskTolerance',
        'confidenceThreshold',
        'intelligenceBudgetUsdc',
        'maxRounds',
      ]),
    );
    expect(evaluate.inputSchema.required).toContain('decision');
  });
});

describe('deycid_evaluate_decision', () => {
  it('returns both Markdown and structured content for a completed case', async () => {
    const client = await connect(
      new MockTelegraphClient()
        .on('ONCHAIN_TX_LOOKUP', { result: OK_TX })
        .on('WALLET_BALANCE_CHECK', { result: OK_BALANCE })
        .fallback({ result: { status: 'success' } }),
    );

    const result = await client.callTool({
      name: 'deycid_evaluate_decision',
      arguments: {
        decision: `Should I execute this transaction sending USDC to ${ADDR}?`,
        transactionHash: TX,
        chain: 'base',
        riskTolerance: 'medium',
      },
    });

    const md = textOf(result);
    expect(md).toContain('## Deycid Decision');
    expect(md).toContain('Deycid confidence');
    expect(md).toContain('Intelligence economics');

    const s = structuredOf(result);
    expect(s.ok).toBe(true);
    const receipt = s.receipt as Record<string, unknown>;
    expect(receipt.caseId).toBe('case-1042');
    expect(['APPROVE', 'REJECT', 'ABSTAIN']).toContain(receipt.verdict);
    expect(typeof receipt.deycidConfidence).toBe('number');
    expect(receipt.budget).toBeTruthy();
  });

  it('rejects a decision below the minimum length before spending anything', async () => {
    const mock = new MockTelegraphClient().fallback({ result: OK_TX });
    const client = await connect(mock);

    // The SDK enforces the declared input schema and returns a tool error
    // result rather than rejecting, so a calling agent can branch on it.
    const result = await client.callTool({
      name: 'deycid_evaluate_decision',
      arguments: { decision: 'no' },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('validation error');
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects a malformed transaction hash at the schema boundary', async () => {
    const mock = new MockTelegraphClient().fallback({ result: OK_TX });
    const client = await connect(mock);

    const result = await client.callTool({
      name: 'deycid_evaluate_decision',
      arguments: { decision: 'Should I execute this transaction?', transactionHash: '0xshort' },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('32-byte hex string');
    expect(mock.calls).toHaveLength(0);
  });

  it('never exceeds the requested intelligence budget', async () => {
    const client = await connect(
      new MockTelegraphClient().fallback({ result: { unreadable: true }, costUsd: 0.02 }),
    );

    const result = await client.callTool({
      name: 'deycid_evaluate_decision',
      arguments: {
        decision: `Should I execute this transaction sending USDC to ${ADDR} via Aave?`,
        transactionHash: TX,
        intelligenceBudgetUsdc: 0.05,
      },
    });

    const receipt = structuredOf(result).receipt as { budget: { allocatedUsdc: number; spentUsdc: number } };
    expect(receipt.budget.spentUsdc).toBeLessThanOrEqual(receipt.budget.allocatedUsdc);
  });
});

describe('deycid_case_status', () => {
  it('returns a useful error for an unknown case id', async () => {
    const client = await connect(new MockTelegraphClient().fallback({ result: OK_TX }));

    const result = await client.callTool({
      name: 'deycid_case_status',
      arguments: { caseId: 'case-does-not-exist' },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    const s = structuredOf(result);
    expect(s.ok).toBe(false);
    expect(s.code).toBe('CASE_NOT_FOUND');
    expect(textOf(result)).toContain('CASE_NOT_FOUND');
  });

  it('reads back a case created by an earlier evaluate call', async () => {
    const client = await connect(new MockTelegraphClient().fallback({ result: OK_TX }));

    const created = await client.callTool({
      name: 'deycid_evaluate_decision',
      arguments: {
        decision: `Should I execute this transaction sending USDC to ${ADDR}?`,
        transactionHash: TX,
      },
    });
    const caseId = (structuredOf(created).receipt as { caseId: string }).caseId;

    const status = await client.callTool({ name: 'deycid_case_status', arguments: { caseId } });
    const receipt = structuredOf(status).receipt as { caseId: string; state: string };
    expect(receipt.caseId).toBe(caseId);
    expect(receipt.state).toBeTruthy();
  });
});

describe('deycid_network_status', () => {
  it('reports configured intents, policies and process telemetry', async () => {
    const client = await connect(new MockTelegraphClient().fallback({ result: OK_TX }));

    const result = await client.callTool({ name: 'deycid_network_status', arguments: {} });
    const s = structuredOf(result);

    expect(s.ok).toBe(true);
    const deycid = s.deycid as { configuredIntents: number; policies: unknown[] };
    expect(deycid.configuredIntents).toBeGreaterThan(0);
    expect(deycid.policies).toHaveLength(3);

    // No wallet was supplied to registerTools in this harness.
    expect(s.wallet).toBeNull();

    const telemetry = s.telemetry as { totalCases: number; averageConfidence: number | null };
    expect(telemetry.totalCases).toBe(0);
    expect(telemetry.averageConfidence).toBeNull();

    const md = textOf(result);
    expect(md).toContain('Deycid network status');
    expect(md).toContain('eip155:84532');
    expect(md).toContain('paid intelligence disabled');
  });
});

describe('progress notifications', () => {
  // A live multi-round run was cut off by the MCP client's default 60s request
  // timeout. Progress notifications let a client extend its deadline and show
  // the user what is being bought meanwhile.
  it('emits progress for each intelligence request when a token is supplied', async () => {
    const client = await connect(new MockTelegraphClient().fallback({ result: OK_TX }));

    const seen: { progress: number; message?: string }[] = [];
    const result = await client.callTool(
      {
        name: 'deycid_evaluate_decision',
        arguments: {
          decision: `Should I execute this transaction sending USDC to ${ADDR} via Aave?`,
          transactionHash: TX,
        },
      },
      undefined,
      {
        onprogress: (p: { progress: number; message?: string }) => {
          seen.push({ progress: p.progress, ...(p.message ? { message: p.message } : {}) });
        },
        resetTimeoutOnProgress: true,
      },
    );

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.message).toMatch(/Round 1: requesting/);
    // Progress is monotonic.
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]!.progress).toBeGreaterThanOrEqual(seen[i - 1]!.progress);
    }
  });

  it('runs normally when the client asks for no progress', async () => {
    const client = await connect(new MockTelegraphClient().fallback({ result: OK_TX }));
    const result = await client.callTool({
      name: 'deycid_evaluate_decision',
      arguments: {
        decision: `Should I execute this transaction sending USDC to ${ADDR}?`,
        transactionHash: TX,
      },
    });
    expect((result as { isError?: boolean }).isError).toBeFalsy();
  });
});

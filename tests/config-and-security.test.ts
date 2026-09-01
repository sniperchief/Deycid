import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BASE_SEPOLIA_CAIP2, loadConfig, loadEnvFiles } from '../src/config/env.js';
import { AgentWallet } from '../src/payments/wallet.js';
import { redactSecrets } from '../src/utils/logger.js';
import { getPolicy, listPolicies, resolveCaseParameters } from '../src/decision/policy-engine.js';

/**
 * Configuration validation and the handling of key material.
 *
 * The key used below is a well-known throwaway test vector (Hardhat account
 * #0). It holds nothing and is here only to exercise derivation.
 */
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

describe('loadConfig', () => {
  it('defaults to the Telegraph testnet node and Base Sepolia', () => {
    const c = loadConfig({});
    expect(c.telegraphNodeUrl).toBe('https://devnode.telegraphprotocol.com');
    expect(c.telegraphEngineUrl).toBe('https://devnode.telegraphprotocol.com/engine');
    expect(c.paymentNetwork).toBe(BASE_SEPOLIA_CAIP2);
    expect(c.paymentNetwork).toBe('eip155:84532');
  });

  it('starts without a private key, leaving payments disabled', () => {
    const c = loadConfig({});
    expect(c.agentPrivateKey).toBeUndefined();
  });

  it('accepts TELEGRAPH_EVM_PRIVATE_KEY as an alias for AGENT_PRIVATE_KEY', () => {
    const c = loadConfig({ TELEGRAPH_EVM_PRIVATE_KEY: TEST_KEY });
    expect(c.agentPrivateKey).toBe(TEST_KEY);
  });

  it('prefers AGENT_PRIVATE_KEY when both are set', () => {
    const other = `0x${'1'.repeat(64)}`;
    const c = loadConfig({ AGENT_PRIVATE_KEY: TEST_KEY, TELEGRAPH_EVM_PRIVATE_KEY: other });
    expect(c.agentPrivateKey).toBe(TEST_KEY);
  });

  it('rejects a malformed private key without echoing its value', () => {
    const secret = 'totally-not-a-key-but-secret-anyway';
    try {
      loadConfig({ AGENT_PRIVATE_KEY: secret });
      expect.unreachable('should have thrown');
    } catch (err) {
      const text = `${(err as Error).message} ${JSON.stringify(err)}`;
      expect(text).toContain('32-byte hex');
      expect(text).not.toContain(secret);
    }
  });

  it('rejects a non-URL Telegraph endpoint', () => {
    expect(() => loadConfig({ TELEGRAPH_NODE_URL: 'not a url' })).toThrow(/not a valid URL/);
  });

  it('rejects a payment network that is not a CAIP-2 id', () => {
    expect(() => loadConfig({ TELEGRAPH_PAYMENT_NETWORK: 'base' })).toThrow(/CAIP-2/);
  });

  it('rejects an out-of-range timeout', () => {
    expect(() => loadConfig({ TELEGRAPH_REQUEST_TIMEOUT_MS: '5' })).toThrow(/Invalid configuration/);
  });

  it('strips a trailing slash from endpoint URLs', () => {
    const c = loadConfig({ TELEGRAPH_NODE_URL: 'https://example.com/node/' });
    expect(c.telegraphNodeUrl).toBe('https://example.com/node');
  });
});

describe('AgentWallet', () => {
  it('returns undefined when no key is configured', () => {
    expect(AgentWallet.fromConfig(loadConfig({}))).toBeUndefined();
  });

  it('derives the expected address', () => {
    const wallet = AgentWallet.fromConfig(loadConfig({ AGENT_PRIVATE_KEY: TEST_KEY }))!;
    expect(wallet.getAgentAddress()).toBe(TEST_ADDRESS);
    expect(wallet.getShortAddress()).toBe('0xf39F...2266');
  });

  it('never exposes the private key through getInfo or serialization', () => {
    const wallet = AgentWallet.fromConfig(loadConfig({ AGENT_PRIVATE_KEY: TEST_KEY }))!;

    const info = JSON.stringify(wallet.getInfo());
    const whole = JSON.stringify(wallet);

    for (const text of [info, whole]) {
      expect(text).not.toContain(TEST_KEY);
      expect(text).not.toContain(TEST_KEY.slice(2));
      expect(text).not.toContain('privateKey');
    }
    expect(JSON.parse(whole).address).toBe(TEST_ADDRESS);
  });

  it('reports the configured payment network and per-call ceiling', () => {
    const wallet = AgentWallet.fromConfig(
      loadConfig({ AGENT_PRIVATE_KEY: TEST_KEY, MAX_PAYMENT_PER_CALL_USDC: '0.02' }),
    )!;
    expect(wallet.getInfo()).toEqual({
      address: TEST_ADDRESS,
      network: 'eip155:84532',
      maxPaymentPerCallUsdc: 0.02,
    });
  });
});

describe('redactSecrets', () => {
  it('redacts values on secret-looking keys', () => {
    const out = redactSecrets({ privateKey: TEST_KEY, api_key: 'abc', nested: { secret: 'x' } }) as Record<
      string,
      unknown
    >;
    expect(out.privateKey).toBe('[redacted]');
    expect(out.api_key).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).secret).toBe('[redacted]');
  });

  it('redacts a raw key that turns up loose inside free text', () => {
    const out = redactSecrets({ message: `leaked ${TEST_KEY} here` }) as { message: string };
    expect(out.message).not.toContain(TEST_KEY);
    expect(out.message).toContain('0x[redacted]');
  });

  it('leaves ordinary values alone', () => {
    const out = redactSecrets({ address: TEST_ADDRESS, amount: 0.01 }) as Record<string, unknown>;
    expect(out.address).toBe(TEST_ADDRESS);
    expect(out.amount).toBe(0.01);
  });

  it('terminates on a cyclic structure', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    expect(() => redactSecrets(cyclic)).not.toThrow();
  });
});

describe('policy engine', () => {
  it('demands more confidence the less risk the caller tolerates', () => {
    expect(getPolicy('low').confidenceTarget).toBeGreaterThan(getPolicy('medium').confidenceTarget);
    expect(getPolicy('medium').confidenceTarget).toBeGreaterThan(getPolicy('high').confidenceTarget);
  });

  it('tolerates less contradiction the less risk the caller tolerates', () => {
    expect(getPolicy('low').maxContradictionRatio).toBeLessThan(getPolicy('high').maxContradictionRatio);
    expect(getPolicy('low').contradictionPenaltyWeight).toBeGreaterThan(
      getPolicy('high').contradictionPenaltyWeight,
    );
  });

  it('exposes exactly three policies', () => {
    expect(listPolicies()).toHaveLength(3);
  });

  it('clamps a requested budget and round count to the policy ceiling', () => {
    const policy = getPolicy('high');
    const r = resolveCaseParameters(
      policy,
      { intelligenceBudgetUsdc: 100, maxRounds: 99 },
      { confidenceThreshold: 0.9, intelligenceBudgetUsdc: 0.1, maxRounds: 3 },
    );
    expect(r.intelligenceBudgetUsdc).toBe(policy.maxIntelligenceBudgetUsdc);
    expect(r.maxRounds).toBe(policy.maxRounds);
  });

  it('lets a caller ask for a stricter threshold than the policy band', () => {
    const r = resolveCaseParameters(
      getPolicy('high'),
      { confidenceThreshold: 0.97 },
      { confidenceThreshold: 0.9, intelligenceBudgetUsdc: 0.1, maxRounds: 3 },
    );
    expect(r.confidenceThreshold).toBe(0.97);
  });
});

describe('loadEnvFiles', () => {
  const dirs: string[] = [];
  const touched: string[] = [];

  const scratch = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'deycid-env-'));
    dirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const k of touched.splice(0)) delete process.env[k];
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('returns an empty list when no env file exists', () => {
    expect(loadEnvFiles(['.env.local', '.env'], scratch())).toEqual([]);
  });

  it('reads values out of .env', () => {
    const d = scratch();
    writeFileSync(join(d, '.env'), 'DEYCID_T_A=from-env\n');
    touched.push('DEYCID_T_A');
    expect(loadEnvFiles(['.env.local', '.env'], d)).toEqual(['.env']);
    expect(process.env.DEYCID_T_A).toBe('from-env');
  });

  it('lets .env.local win over .env', () => {
    const d = scratch();
    writeFileSync(join(d, '.env'), 'DEYCID_T_B=base\n');
    writeFileSync(join(d, '.env.local'), 'DEYCID_T_B=local\n');
    touched.push('DEYCID_T_B');
    expect(loadEnvFiles(['.env.local', '.env'], d)).toEqual(['.env.local', '.env']);
    expect(process.env.DEYCID_T_B).toBe('local');
  });

  it('never clobbers a variable already in the real environment', () => {
    const d = scratch();
    writeFileSync(join(d, '.env.local'), 'DEYCID_T_C=from-file\n');
    touched.push('DEYCID_T_C');
    process.env.DEYCID_T_C = 'from-mcp-client';
    loadEnvFiles(['.env.local', '.env'], d);
    expect(process.env.DEYCID_T_C).toBe('from-mcp-client');
  });

  it('skips comments and blank lines, and handles quotes and export', () => {
    const d = scratch();
    writeFileSync(
      join(d, '.env'),
      ['# a comment', '', 'DEYCID_T_D="quoted value"', "DEYCID_T_E='single'", 'export DEYCID_T_F=exported'].join('\n'),
    );
    touched.push('DEYCID_T_D', 'DEYCID_T_E', 'DEYCID_T_F');
    loadEnvFiles(['.env.local', '.env'], d);
    expect(process.env.DEYCID_T_D).toBe('quoted value');
    expect(process.env.DEYCID_T_E).toBe('single');
    expect(process.env.DEYCID_T_F).toBe('exported');
  });

  it('strips a trailing inline comment on an unquoted value only', () => {
    const d = scratch();
    writeFileSync(join(d, '.env'), 'DEYCID_T_G=value # note\nDEYCID_T_H="keeps # hash"\n');
    touched.push('DEYCID_T_G', 'DEYCID_T_H');
    loadEnvFiles(['.env.local', '.env'], d);
    expect(process.env.DEYCID_T_G).toBe('value');
    expect(process.env.DEYCID_T_H).toBe('keeps # hash');
  });

  it('treats an empty file as read but contributing no configuration', () => {
    const d = scratch();
    writeFileSync(join(d, '.env.local'), '');
    expect(loadEnvFiles(['.env.local', '.env'], d)).toEqual(['.env.local']);
    expect(loadConfig({}).agentPrivateKey).toBeUndefined();
  });
});

describe('DEFAULT_CONFIDENCE_THRESHOLD precedence', () => {
  // Regression: this variable was documented, validated and plumbed through,
  // but the policy band always won, so setting it did nothing at all.
  it('is undefined when the operator has not set it', () => {
    expect(loadConfig({}).defaultConfidenceThreshold).toBeUndefined();
    expect(loadConfig({ DEFAULT_CONFIDENCE_THRESHOLD: '' }).defaultConfidenceThreshold).toBeUndefined();
  });

  it('is read when set', () => {
    expect(loadConfig({ DEFAULT_CONFIDENCE_THRESHOLD: '0.5' }).defaultConfidenceThreshold).toBe(0.5);
  });

  it('still rejects an out-of-range value', () => {
    expect(() => loadConfig({ DEFAULT_CONFIDENCE_THRESHOLD: '1.5' })).toThrow(/Invalid configuration/);
  });

  it('falls back to the policy band when unset', () => {
    const r = resolveCaseParameters(getPolicy('low'), {}, { intelligenceBudgetUsdc: 0.1, maxRounds: 3 });
    expect(r.confidenceThreshold).toBe(getPolicy('low').confidenceTarget);
  });

  it('overrides the policy band when set', () => {
    const r = resolveCaseParameters(
      getPolicy('low'),
      {},
      { confidenceThreshold: 0.5, intelligenceBudgetUsdc: 0.1, maxRounds: 3 },
    );
    expect(r.confidenceThreshold).toBe(0.5);
  });

  it('is itself overridden by an explicit per-case threshold', () => {
    const r = resolveCaseParameters(
      getPolicy('low'),
      { confidenceThreshold: 0.7 },
      { confidenceThreshold: 0.5, intelligenceBudgetUsdc: 0.1, maxRounds: 3 },
    );
    expect(r.confidenceThreshold).toBe(0.7);
  });
});

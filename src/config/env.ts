import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ConfigurationError } from '../errors.js';
import { setLogLevel, type LogLevel } from '../utils/logger.js';

/**
 * Configuration, validated once at startup.
 *
 * Defaults target the public Telegraph testnet node documented at
 * docs.telegraphprotocol.com/docs/using/x402-inference. The node bills on
 * Base Sepolia (CAIP-2 `eip155:84532`), so that — not Base mainnet — is the
 * network Deycid signs payments for.
 */

/** USDC on Base Sepolia, per the Telegraph x402 payment-networks table. */
export const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
/** CAIP-2 id of the network the Telegraph testnet node bills against. */
export const BASE_SEPOLIA_CAIP2 = 'eip155:84532';

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Loads `.env` style files into `process.env`.
 *
 * Precedence, strongest first:
 *   1. variables already in the real environment (what an MCP client passes in
 *      its `env` block, or an inline `FOO=bar npm start`)
 *   2. `.env.local`
 *   3. `.env`
 *
 * An already-set variable is never clobbered, so a key supplied by Claude
 * Desktop always wins over one left in a file. Missing files are not an error —
 * running with no file at all is a supported configuration.
 *
 * Deliberately hand-rolled rather than pulling in `dotenv`: the whole parser is
 * the twenty lines below, and controlling precedence matters more here than
 * matching every dotenv edge case.
 *
 * @returns the names of the files that were actually read, for logging. Values
 *          are never returned or logged.
 */
export function loadEnvFiles(
  files: readonly string[] = ['.env.local', '.env'],
  cwd: string = process.cwd(),
): string[] {
  const loaded: string[] = [];

  for (const file of files) {
    const full = resolve(cwd, file);
    let contents: string;
    try {
      contents = readFileSync(full, 'utf8');
    } catch {
      continue; // absent or unreadable — both fine
    }
    loaded.push(file);

    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;

      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;

      const key = match[1]!;
      if (key in process.env) continue; // never clobber a stronger source

      let value = match[2]!.trim();
      const quote = value[0];
      if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
        value = value.slice(1, -1);
        if (quote === '"') value = value.replace(/\\n/g, '\n');
      } else {
        // Strip a trailing inline comment on unquoted values only.
        value = value.replace(/\s+#.*$/, '');
      }
      process.env[key] = value;
    }
  }

  return loaded;
}

/**
 * A number the operator may leave unset.
 *
 * `DEFAULT_CONFIDENCE_THRESHOLD` needs this: unset must mean "let the risk
 * policy decide", which is different from any particular number. Collapsing
 * the two is what made the variable silently inert.
 */
const optionalNumberFromEnv = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : Number(v)));

const numberFromEnv = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? fallback : Number(v)))
    .pipe(z.number().finite());

const RawEnvSchema = z.object({
  AGENT_PRIVATE_KEY: z.string().optional(),
  TELEGRAPH_EVM_PRIVATE_KEY: z.string().optional(),
  TELEGRAPH_NODE_URL: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : 'https://devnode.telegraphprotocol.com')),
  TELEGRAPH_ENGINE_URL: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : 'https://devnode.telegraphprotocol.com/engine')),
  TELEGRAPH_PAYMENT_NETWORK: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : BASE_SEPOLIA_CAIP2)),
  TELEGRAPH_REQUEST_TIMEOUT_MS: numberFromEnv(45_000).pipe(z.number().int().min(1_000).max(600_000)),
  MAX_PAYMENT_PER_CALL_USDC: numberFromEnv(0.05).pipe(z.number().positive().max(5)),
  DEFAULT_CONFIDENCE_THRESHOLD: optionalNumberFromEnv.pipe(
    z.union([z.number().min(0.01).max(0.99), z.undefined()]),
  ),
  DEFAULT_INTELLIGENCE_BUDGET_USDC: numberFromEnv(0.1).pipe(z.number().positive().max(100)),
  DEFAULT_MAX_ROUNDS: numberFromEnv(3).pipe(z.number().int().min(1).max(10)),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).optional().default('info'),
});

export interface DeycidConfig {
  /**
   * Present only when a well-formed key was supplied. Absent means Deycid runs
   * in discovery-only mode: free Telegraph endpoints work, paid ones refuse.
   */
  agentPrivateKey?: `0x${string}`;
  telegraphNodeUrl: string;
  telegraphEngineUrl: string;
  paymentNetwork: string;
  requestTimeoutMs: number;
  maxPaymentPerCallUsdc: number;
  /**
   * Undefined when the operator has not set one, which means the risk policy's
   * own confidence band applies. See resolveCaseParameters for precedence.
   */
  defaultConfidenceThreshold?: number;
  defaultIntelligenceBudgetUsdc: number;
  defaultMaxRounds: number;
  logLevel: LogLevel;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function assertHttpUrl(name: string, value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError(`${name} is not a valid URL.`, { variable: name });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ConfigurationError(`${name} must be an http(s) URL.`, { variable: name });
  }
}

/**
 * Parses and validates process configuration.
 *
 * Throws `ConfigurationError` on anything malformed. A missing private key is
 * deliberately *not* an error — the server still exposes discovery and case
 * inspection, and only refuses when a paid call is actually attempted.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): DeycidConfig {
  const parsed = RawEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigurationError(`Invalid configuration: ${issues.join('; ')}`, { issues });
  }
  const env = parsed.data;

  // AGENT_PRIVATE_KEY is Deycid's own name; TELEGRAPH_EVM_PRIVATE_KEY is the
  // name the official Telegraph MCP server uses. Accept either.
  const rawKey = (env.AGENT_PRIVATE_KEY ?? env.TELEGRAPH_EVM_PRIVATE_KEY ?? '').trim();
  let agentPrivateKey: `0x${string}` | undefined;
  if (rawKey !== '') {
    if (!PRIVATE_KEY_PATTERN.test(rawKey)) {
      // The offending value is never echoed back.
      throw new ConfigurationError(
        'AGENT_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string. Value withheld from this message.',
        { variable: 'AGENT_PRIVATE_KEY' },
      );
    }
    agentPrivateKey = rawKey as `0x${string}`;
  }

  assertHttpUrl('TELEGRAPH_NODE_URL', env.TELEGRAPH_NODE_URL);
  assertHttpUrl('TELEGRAPH_ENGINE_URL', env.TELEGRAPH_ENGINE_URL);

  if (!/^[a-z0-9]+:[a-zA-Z0-9-]+$/.test(env.TELEGRAPH_PAYMENT_NETWORK)) {
    throw new ConfigurationError('TELEGRAPH_PAYMENT_NETWORK must be a CAIP-2 id, e.g. eip155:84532.', {
      variable: 'TELEGRAPH_PAYMENT_NETWORK',
    });
  }

  const config: DeycidConfig = {
    ...(agentPrivateKey ? { agentPrivateKey } : {}),
    telegraphNodeUrl: stripTrailingSlash(env.TELEGRAPH_NODE_URL),
    telegraphEngineUrl: stripTrailingSlash(env.TELEGRAPH_ENGINE_URL),
    paymentNetwork: env.TELEGRAPH_PAYMENT_NETWORK,
    requestTimeoutMs: env.TELEGRAPH_REQUEST_TIMEOUT_MS,
    maxPaymentPerCallUsdc: env.MAX_PAYMENT_PER_CALL_USDC,
    ...(env.DEFAULT_CONFIDENCE_THRESHOLD !== undefined
      ? { defaultConfidenceThreshold: env.DEFAULT_CONFIDENCE_THRESHOLD }
      : {}),
    defaultIntelligenceBudgetUsdc: env.DEFAULT_INTELLIGENCE_BUDGET_USDC,
    defaultMaxRounds: env.DEFAULT_MAX_ROUNDS,
    logLevel: env.LOG_LEVEL,
  };

  setLogLevel(config.logLevel);
  return config;
}

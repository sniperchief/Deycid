#!/usr/bin/env node
import { startWebServer } from './server.js';
import { isDeycidError } from '../errors.js';
import { logger } from '../utils/logger.js';

/**
 * Entry point for the public demo server.
 *
 * Separate from src/index.ts on purpose: the MCP server speaks stdio and must
 * keep stdout clean, while this one listens on a port. They share the engine
 * and nothing else.
 */
startWebServer().catch((err: unknown) => {
  const code = isDeycidError(err) ? err.code : 'WEB_STARTUP_FAILED';
  const message = err instanceof Error ? err.message : String(err);
  logger.error('decision.failed', { phase: 'web-startup', code, error: message });
  process.stderr.write(`\n[Deycid] Fatal (${code}): ${message}\n`);
  process.exit(1);
});

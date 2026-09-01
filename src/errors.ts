/**
 * Deycid error taxonomy.
 *
 * Every error carries a stable `code` so MCP responses can describe a failure
 * without leaking internals. Error messages are written on the assumption that
 * they may be shown to a caller, so nothing secret is ever interpolated into
 * one — see `redactSecrets` in utils/logger.ts for the shared scrubber.
 */

export type DeycidErrorCode =
  | 'TELEGRAPH_UNAVAILABLE'
  | 'TELEGRAPH_REQUEST_FAILED'
  | 'X402_PAYMENT_FAILED'
  | 'INSUFFICIENT_BUDGET'
  | 'INVALID_DECISION'
  | 'UNSUPPORTED_INTENT'
  | 'CONFIDENCE_EVALUATION_FAILED'
  | 'CASE_NOT_FOUND'
  | 'CONFIGURATION_INVALID'
  | 'WALLET_UNAVAILABLE';

export class DeycidError extends Error {
  readonly code: DeycidErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: DeycidErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

/** The Telegraph node could not be reached at all (DNS, connect, timeout, abort). */
export class TelegraphUnavailableError extends DeycidError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('TELEGRAPH_UNAVAILABLE', message, details);
  }
}

/** The Telegraph node answered, but with an error status or an unusable body. */
export class TelegraphRequestError extends DeycidError {
  readonly status: number;
  constructor(message: string, status: number, details: Record<string, unknown> = {}) {
    super('TELEGRAPH_REQUEST_FAILED', message, { ...details, status });
    this.status = status;
  }
}

/** The x402 exchange failed: challenge unparseable, signing refused, settlement rejected. */
export class X402PaymentError extends DeycidError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('X402_PAYMENT_FAILED', message, details);
  }
}

/** A case wanted to buy intelligence it could not afford. */
export class InsufficientBudgetError extends DeycidError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('INSUFFICIENT_BUDGET', message, details);
  }
}

/** The decision request itself is malformed or unusable. */
export class InvalidDecisionError extends DeycidError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('INVALID_DECISION', message, details);
  }
}

/** An intent was requested that Deycid's registry does not carry. */
export class UnsupportedIntentError extends DeycidError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('UNSUPPORTED_INTENT', message, details);
  }
}

/** The confidence engine was handed evidence it could not score. */
export class ConfidenceEvaluationError extends DeycidError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('CONFIDENCE_EVALUATION_FAILED', message, details);
  }
}

export class CaseNotFoundError extends DeycidError {
  constructor(caseId: string) {
    super('CASE_NOT_FOUND', `No decision case with id "${caseId}".`, { caseId });
  }
}

/** Startup configuration is missing or nonsensical. */
export class ConfigurationError extends DeycidError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('CONFIGURATION_INVALID', message, details);
  }
}

/** A paid operation was attempted with no usable agent wallet. */
export class WalletUnavailableError extends DeycidError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('WALLET_UNAVAILABLE', message, details);
  }
}

export function isDeycidError(err: unknown): err is DeycidError {
  return err instanceof DeycidError;
}

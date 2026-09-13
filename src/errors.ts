import type { ExecutionStatus, ResultContext, SessionEffect } from "./domain/types.js";

/** Stable error codes safe to expose through MCP. */
export const errorCodes = [
  "invalidConfiguration",
  "invalidInput",
  "disallowedScope",
  "unsupportedCapability",
  "unverifiedCapability",
  "authenticationRequired",
  "authenticationExpired",
  "authenticationUncertain",
  "permissionDenied",
  "notFoundInView",
  "queryIndexUnavailable",
  "cursorInvalid",
  "cursorExpired",
  "cursorContextMismatch",
  "rateLimited",
  "timeout",
  "cancelled",
  "malformedResponse",
  "responseBoundExceeded",
  "outputBoundExceeded",
  "queueExhausted",
  "partialFailure",
] as const;

/** Stable error code. */
export type ErrorCode = (typeof errorCodes)[number];

/** Safe public representation of an operational error. */
export interface SafeError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly execution: ExecutionStatus;
  readonly sessionEffect: SessionEffect;
  readonly retryable: boolean;
  readonly retryConditions: readonly string[];
  readonly nextStep: string;
  readonly context?: ResultContext;
}

/** Error carrying only explicitly constructed, privacy-safe fields. */
export class CloudKitMCPError extends Error {
  readonly details: SafeError;

  constructor(details: SafeError) {
    super(details.message);
    this.name = "CloudKitMCPError";
    this.details = details;
  }

  /** Returns a plain object without stack, cause, or provider values. */
  toSafeObject(): SafeError {
    return this.details;
  }
}

/** Creates a privacy-safe error without retaining an unsafe cause object. */
export function safeError(details: SafeError): CloudKitMCPError {
  return new CloudKitMCPError(details);
}

/** Converts an unknown failure into a bounded generic error. */
export function sanitizeUnknownError(error: unknown): SafeError {
  if (error instanceof CloudKitMCPError) {
    return error.toSafeObject();
  }
  return {
    code: "malformedResponse",
    message: "The operation failed without a safe provider-specific diagnosis.",
    execution: "uncertain",
    sessionEffect: "uncertain",
    retryable: false,
    retryConditions: [],
    nextStep: "Inspect privacy-safe stderr diagnostics and reauthenticate if a rotating user session was in use.",
  };
}

/** Privacy-safe structured lifecycle event. */
export interface DiagnosticEvent {
  readonly event: "operationCompleted" | "operationFailed" | "credentialChanged";
  readonly requestId: string;
  readonly operation?: string;
  readonly durationMilliseconds?: number;
  readonly count?: number;
  readonly code?: string;
}

/** Writes one bounded JSON event to stderr without accepting arbitrary metadata. */
export function writeDiagnosticEvent(event: DiagnosticEvent): void {
  process.stderr.write(`${JSON.stringify({ subsystem: "com.thatfactory.cloudkit-mcp", ...event })}\n`);
}

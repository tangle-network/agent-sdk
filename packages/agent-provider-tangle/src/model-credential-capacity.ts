import { AgentTurnFailureSchema, type AgentTurnFailure } from "@tangle-network/agent-interface";

export type CredentialCapacityCode = "provider_quota_exhausted" | "upstream_unavailable";
export type CredentialCapacityReason = "exhausted" | "unknown" | "held" | "busy";

/** The account owner could not admit a fresh dispatch. HTTP status exists only for an HTTP response. */
export class TangleCredentialCapacityError extends Error {
  readonly code: CredentialCapacityCode;
  readonly reason: CredentialCapacityReason;
  readonly resetAt?: string;
  get failure(): AgentTurnFailure { return { kind: "capacity", code: this.code, ...(this.resetAt ? { resetAt: this.resetAt } : {}) }; }
  declare readonly status?: number;

  constructor(code: CredentialCapacityCode, reason: CredentialCapacityReason, resetAt?: string, httpStatus?: number) {
    super("Subscription account capacity is unavailable");
    this.name = "TangleCredentialCapacityError";
    this.code = code;
    this.reason = reason;
    if (resetAt !== undefined) this.resetAt = resetAt;
    if (httpStatus !== undefined) {
      if (httpStatus !== 429 && httpStatus !== 503) throw new Error("Credential capacity requires a real capacity response");
      Object.defineProperty(this, "status", { value: httpStatus, enumerable: true });
    }
  }
}

/** A deterministic credential route refusal, before dispatch or account admission. */
export class TangleCredentialRefusalError extends Error {
  readonly code = "model_credential_refused";
  readonly reason = "unsupported_route";
  readonly failure: AgentTurnFailure = { kind: "caller", code: this.code };
  declare readonly status?: number;

  constructor(httpStatus?: number) {
    super("Subscription credential route is unsupported");
    this.name = "TangleCredentialRefusalError";
    if (httpStatus !== undefined) {
      if (httpStatus !== 400) throw new Error("Credential refusal requires a real client-error response");
      Object.defineProperty(this, "status", { value: httpStatus, enumerable: true });
    }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** The fixed public route refusal shares the bounded capacity transport, never private diagnostics. */
export function parseCredentialRefusal(value: unknown, httpStatus?: number): TangleCredentialRefusalError | undefined {
  if (httpStatus !== undefined && httpStatus !== 400) return undefined;
  const envelope = record(value);
  if (!envelope || Object.keys(envelope).some((key) => key !== "error")) return undefined;
  const error = record(envelope.error);
  if (!error || Object.keys(error).some((key) => key !== "code" && key !== "reason")) return undefined;
  if (error.code !== "model_credential_refused" || error.reason !== "unsupported_route") return undefined;
  return new TangleCredentialRefusalError(httpStatus);
}

/** Only fixed public fields survive parsing; upstream messages and private diagnostics do not. */
export function parseCredentialCapacity(value: unknown, httpStatus?: number): TangleCredentialCapacityError | undefined {
  if (httpStatus !== undefined && httpStatus !== 429 && httpStatus !== 503) return undefined;
  const envelope = record(value);
  if (!envelope || Object.keys(envelope).some((key) => key !== "error")) return undefined;
  const error = record(envelope.error);
  if (!error || Object.keys(error).some((key) => !["code", "reason", "resetAt"].includes(key))) return undefined;
  const { code, reason, resetAt } = error;
  if (code !== "provider_quota_exhausted" && code !== "upstream_unavailable") return undefined;
  if (reason !== "exhausted" && reason !== "unknown" && reason !== "held" && reason !== "busy") return undefined;
  if ((code === "provider_quota_exhausted") !== (reason === "exhausted")) return undefined;
  if (resetAt !== undefined && (typeof resetAt !== "string" || resetAt.length !== 24 ||
    !Number.isFinite(Date.parse(resetAt)) || new Date(resetAt).toISOString() !== resetAt)) return undefined;
  return new TangleCredentialCapacityError(code, reason, resetAt as string | undefined, httpStatus);
}

/** Classify existing machine codes only; never infer a mechanism from diagnostics. */
export function tangleTurnFailure(record: Record<string, unknown>): AgentTurnFailure | undefined {
  if (record.failure !== undefined) return AgentTurnFailureSchema.parse(record.failure);
  const code = record.errorCode;
  if (typeof code !== "string") return undefined;
  const kind = ["provider_quota_exhausted", "upstream_unavailable", "CAPACITY_EXHAUSTED", "HOST_PRESSURE", "PROVISIONING_PAUSED"].includes(code) ? "capacity"
    : ["model_credential_refused", "PROFILE_UNSUPPORTED", "INVALID_INPUT", "AUTH_FAILED"].includes(code) ? "caller"
    : ["EXECUTION_INTERRUPTED", "NATIVE_CAPTURE_NOT_CONFIRMED", "TRANSPORT_LOST", "SANDBOX_UNREACHABLE"].includes(code) ? "infra" : undefined;
  if (!kind) return undefined;
  return AgentTurnFailureSchema.parse({kind,code, ...(record.resetAt === undefined ? {} : {resetAt:record.resetAt}),
    ...(record.retryAfterMs === undefined ? {} : {retryAfterMs:record.retryAfterMs})});
}

/** A credential-owner process failed without a valid public refusal envelope. */
export class TangleCredentialCommandError extends Error {
  readonly code = "credential_command_failed" as const;
  readonly failure: AgentTurnFailure = { kind: "infra", code: this.code };
  constructor(readonly exitCode: number | null, readonly terminationSignal: string | null) {
    super(`Tangle credential command failed (${exitCode === null ? `signal ${terminationSignal ?? "unknown"}` : `exit ${exitCode}`})`);
    this.name = "TangleCredentialCommandError";
  }
}

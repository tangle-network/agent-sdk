export type CredentialCapacityCode = "provider_quota_exhausted" | "upstream_unavailable";
export type CredentialCapacityReason = "exhausted" | "unknown" | "held" | "busy";

/** The account owner could not admit a fresh dispatch. HTTP status exists only for an HTTP response. */
export class TangleCredentialCapacityError extends Error {
  readonly code: CredentialCapacityCode;
  readonly reason: CredentialCapacityReason;
  readonly resetAt?: string;
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

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
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

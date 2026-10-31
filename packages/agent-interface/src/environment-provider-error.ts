/**
 * The failures an environment provider reports, as one closed set.
 *
 * A provider maps every vendor failure into one of these codes before it
 * leaves the adapter, so a consumer decides retry, refusal and cleanup from
 * the code and never from vendor message text.
 *
 * - `refused`: the request names a field, axis, harness or option this
 *   provider cannot honor. It is refused before any vendor call, `path` names
 *   the refused field, and nothing was provisioned.
 * - `invalid_input`: the request is malformed.
 * - `auth_failed`: the vendor rejected the credential. Terminal; never retried.
 * - `not_found`: the vendor has no such environment or image.
 * - `conflict`: the vendor reports a state conflict, for example a second delete.
 * - `capacity`: upstream capacity, quota or rate limit (status 429, 503, 529 or
 *   an upstream capacity code in `upstreamCode`). Retryable later.
 * - `transport`: the network or vendor service failed. Retryable.
 * - `timeout`: a bounded operation ran out of time.
 * - `aborted`: the caller's signal ended the operation.
 * - `provision_failed`: the vendor could not create or start the sandbox.
 * - `materialization_failed`: the harness or profile could not be applied in
 *   the sandbox.
 * - `harness_failed`: the harness process failed.
 * - `cleanup_failed`: a sandbox could not be destroyed; `cleanupHandle` names it.
 */
export const ENVIRONMENT_PROVIDER_ERROR_CODES = [
  "refused",
  "invalid_input",
  "auth_failed",
  "not_found",
  "conflict",
  "capacity",
  "transport",
  "timeout",
  "aborted",
  "provision_failed",
  "materialization_failed",
  "harness_failed",
  "cleanup_failed",
] as const;

export type EnvironmentProviderErrorCode =
  (typeof ENVIRONMENT_PROVIDER_ERROR_CODES)[number];

/** Codes a caller may retry without changing the request. */
const RETRYABLE_CODES: ReadonlySet<EnvironmentProviderErrorCode> = new Set([
  "capacity",
  "transport",
]);

const MAX_MESSAGE_LENGTH = 2_000;
const MIN_SCRUBBED_SECRET_LENGTH = 6;

/** Credential-shaped text that is removed from a message even when the caller named no secret. */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{12,}/g,
  /\b(?:api[_-]?key|token|secret|password)=[^\s&"']{4,}/gi,
];

/**
 * Bound a vendor message and remove credentials from it.
 *
 * Every value in `secrets` is removed wherever it appears, and so is any
 * credential-shaped token. The result is at most 2,000 characters.
 */
export function scrubEnvironmentProviderMessage(
  message: string,
  secrets: readonly string[] = [],
): string {
  let scrubbed = message;
  for (const secret of secrets) {
    if (secret.length >= MIN_SCRUBBED_SECRET_LENGTH) {
      scrubbed = scrubbed.split(secret).join("[redacted]");
    }
  }
  for (const pattern of CREDENTIAL_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, "[redacted]");
  }
  return scrubbed.length > MAX_MESSAGE_LENGTH
    ? `${scrubbed.slice(0, MAX_MESSAGE_LENGTH)}...`
    : scrubbed;
}

export interface EnvironmentProviderErrorOptions {
  /** HTTP status when the failure came from an HTTP service. */
  status?: number;
  /** The refused create or turn field, for `refused` and `invalid_input`. */
  path?: string;
  /** The upstream's own capacity or failure code, for example `rate_limit_exceeded`. */
  upstreamCode?: string;
  /** Name of the provider that raised the error. */
  provider?: string;
  /** The sandbox a failed cleanup left behind, for `cleanup_failed` and for any failure after provisioning. */
  cleanupHandle?: { environmentId: string; provider?: string };
  /** The vendor error. Kept as `cause`; its message is scrubbed on this error, not on the cause. */
  cause?: unknown;
  /** Secret values removed from the message wherever they appear. */
  secrets?: readonly string[];
}

/** A classified provider failure with a stable code and a scrubbed, bounded message. */
export class EnvironmentProviderError extends Error {
  readonly code: EnvironmentProviderErrorCode;
  readonly status?: number;
  readonly path?: string;
  readonly upstreamCode?: string;
  readonly provider?: string;
  readonly cleanupHandle?: { environmentId: string; provider?: string };

  constructor(
    code: EnvironmentProviderErrorCode,
    message: string,
    options: EnvironmentProviderErrorOptions = {},
  ) {
    super(
      scrubEnvironmentProviderMessage(message, options.secrets),
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "EnvironmentProviderError";
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.path !== undefined) this.path = options.path;
    if (options.upstreamCode !== undefined) this.upstreamCode = options.upstreamCode;
    if (options.provider !== undefined) this.provider = options.provider;
    if (options.cleanupHandle !== undefined) this.cleanupHandle = options.cleanupHandle;
  }

  /** Whether a caller may retry the same request later. `auth_failed` is never retryable. */
  get retryable(): boolean {
    return RETRYABLE_CODES.has(this.code);
  }
}

export function isEnvironmentProviderError(
  value: unknown,
): value is EnvironmentProviderError {
  return (
    value instanceof EnvironmentProviderError ||
    (value instanceof Error &&
      value.name === "EnvironmentProviderError" &&
      ENVIRONMENT_PROVIDER_ERROR_CODES.includes(
        (value as { code?: EnvironmentProviderErrorCode }).code as EnvironmentProviderErrorCode,
      ))
  );
}

/**
 * The code for an HTTP failure status. 429, 503 and 529 are upstream capacity;
 * every other 5xx is transport; 401 and 403 are an authentication failure;
 * 408 is a timeout.
 */
export function environmentProviderErrorCodeForStatus(
  status: number,
): EnvironmentProviderErrorCode {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 404) return "not_found";
  if (status === 408) return "timeout";
  if (status === 409) return "conflict";
  if (status === 429 || status === 503 || status === 529) return "capacity";
  if (status >= 500) return "transport";
  return "invalid_input";
}

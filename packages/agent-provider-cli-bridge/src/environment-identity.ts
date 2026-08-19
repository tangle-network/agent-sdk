import { createHash, randomUUID } from "node:crypto";
import type { Sha256Digest } from "@tangle-network/agent-interface";

const CLI_BRIDGE_ENVIRONMENT_ID_PREFIX = "cb1.";
const MAX_ENVIRONMENT_ID_LENGTH = 512;

export interface CliBridgeEnvironmentRoute {
  readonly backend?: string;
  readonly model?: string;
  readonly createDigest: Sha256Digest;
}

/**
 * Keep the exact route and create digest inside the provider-owned id.
 * The nonce hides a caller idempotency key while repeated creates stay stable.
 */
export function cliBridgeEnvironmentId(
  route: Omit<CliBridgeEnvironmentRoute, "createDigest">,
  createDigest: Sha256Digest,
  idempotencyKey?: string,
): string {
  assertEnvironmentRoute(route.backend, route.model, createDigest);
  const nonce = idempotencyKey === undefined
    ? randomUUID()
    : createHash("sha256").update(idempotencyKey).digest("base64url");
  const payload = JSON.stringify([
    route.backend ?? null,
    route.model ?? null,
    createDigest,
    nonce,
  ]);
  const id = `${CLI_BRIDGE_ENVIRONMENT_ID_PREFIX}${Buffer.from(payload).toString("base64url")}`;
  if (id.length > MAX_ENVIRONMENT_ID_LENGTH) {
    throw new Error(
      "cli-bridge route is too long to retain in an environment id",
    );
  }
  return id;
}

/** Recover the exact route from a provider-owned retained identifier. */
export function cliBridgeEnvironmentRoute(
  id: string,
): CliBridgeEnvironmentRoute {
  if (!id.startsWith(CLI_BRIDGE_ENVIRONMENT_ID_PREFIX)) {
    throw new Error(
      "cli-bridge environment id is not a provider-owned retained identity",
    );
  }
  if (id.length > MAX_ENVIRONMENT_ID_LENGTH) {
    throw new Error("cli-bridge environment id has invalid retained route data");
  }
  const encoded = id.slice(CLI_BRIDGE_ENVIRONMENT_ID_PREFIX.length);
  let payload: unknown;
  try {
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded) throw new Error("non-canonical encoding");
    payload = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new Error("cli-bridge environment id has invalid retained route data");
  }
  if (!Array.isArray(payload) || payload.length !== 4) {
    throw new Error("cli-bridge environment id has invalid retained route data");
  }
  const [backend, model, createDigest, nonce] = payload;
  if (
    !optionalRouteValue(backend) ||
    !optionalRouteValue(model) ||
    !sha256Digest(createDigest) ||
    !modelMatchesBackend(backend, model) ||
    typeof nonce !== "string" ||
    nonce.length === 0 ||
    nonce.length > 64
  ) {
    throw new Error("cli-bridge environment id has invalid retained route data");
  }
  return {
    ...(backend === null ? {} : { backend }),
    ...(model === null ? {} : { model }),
    createDigest,
  };
}

function optionalRouteValue(value: unknown): value is string | null {
  return value === null || routeValue(value);
}

function routeValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ENVIRONMENT_ID_LENGTH &&
    value.trim() === value
  );
}

function sha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function modelMatchesBackend(
  backend: string | null,
  model: string | null,
): boolean {
  if (model === null) return backend === null;
  return backend === null || model === backend || model.startsWith(`${backend}/`);
}

function assertEnvironmentRoute(
  backend: string | undefined,
  model: string | undefined,
  createDigest: Sha256Digest,
): void {
  if (
    !optionalRouteValue(backend ?? null) ||
    !optionalRouteValue(model ?? null) ||
    !sha256Digest(createDigest) ||
    !modelMatchesBackend(backend ?? null, model ?? null)
  ) {
    throw new Error("cli-bridge environment route is invalid");
  }
}

import { z } from "zod";
import {
  boundedIdentifierSchema,
  boundedStringSchema,
} from "./contract-limits.js";
import type { TokenUsage } from "./execution-types.js";

/**
 * Freshness discriminator for one observed value. A missing value never reads
 * as a measured zero: a value exists only on `known` and `stale`, so the
 * absence of a number is always visible as `unavailable`, `redacted`, or
 * `unknown`.
 */
export type ObservationState =
  | "known"
  | "stale"
  | "unavailable"
  | "redacted"
  | "unknown";

export const ObservationStateSchema = z.enum([
  "known",
  "stale",
  "unavailable",
  "redacted",
  "unknown",
]);

/** How a known or stale value was obtained, and when. */
export interface ObservationProvenance {
  origin: "measured" | "reported" | "estimated";
  observedAt: string;
  source?: string;
}

export const ObservationProvenanceSchema = z.strictObject({
  origin: z.enum(["measured", "reported", "estimated"]),
  observedAt: z.iso.datetime().max(64),
  source: boundedIdentifierSchema.optional(),
}) satisfies z.ZodType<ObservationProvenance>;

/**
 * One freshness-tagged value. The security invariant is structural: the
 * discriminator is required, and `value` is present only when the state is
 * `known` or `stale`. An `unavailable`, `redacted`, or `unknown` payload
 * carries no value, so downstream code cannot read a missing measurement as a
 * real zero.
 */
export type Observation<T> =
  | { state: "known"; value: T; provenance: ObservationProvenance }
  | { state: "stale"; value: T; provenance: ObservationProvenance; reason: string }
  | { state: "unavailable"; reason: string }
  | { state: "redacted"; reason: string }
  | { state: "unknown" };

/** Build a freshness-tagged observation schema around one value schema. */
export function observationOf<Schema extends z.ZodTypeAny>(value: Schema) {
  return z.discriminatedUnion("state", [
    z.strictObject({
      state: z.literal("known"),
      value,
      provenance: ObservationProvenanceSchema,
    }),
    z.strictObject({
      state: z.literal("stale"),
      value,
      provenance: ObservationProvenanceSchema,
      reason: boundedStringSchema.min(1),
    }),
    z.strictObject({
      state: z.literal("unavailable"),
      reason: boundedStringSchema.min(1),
    }),
    z.strictObject({
      state: z.literal("redacted"),
      reason: boundedStringSchema.min(1),
    }),
    z.strictObject({ state: z.literal("unknown") }),
  ]);
}

const nonNegativeNumberSchema = z.number().finite().nonnegative();

/** Safe identifiers for the environment and its provider session. */
export interface ProviderIdentity {
  provider: string;
  environmentId: string;
  sessionId?: string;
  backend?: string;
}

export const ProviderIdentitySchema = z.strictObject({
  provider: boundedIdentifierSchema,
  environmentId: boundedIdentifierSchema,
  sessionId: boundedIdentifierSchema.optional(),
  backend: boundedIdentifierSchema.optional(),
}) satisfies z.ZodType<ProviderIdentity>;

export const AgentEnvironmentStatusSchema = z.enum([
  "pending",
  "provisioning",
  "running",
  "stopped",
  "failed",
  "expired",
  "unknown",
]);

/** Lifecycle, cleanup, continuity, and persistence of one environment. */
export const EnvironmentLifecycleSchema = z.strictObject({
  status: AgentEnvironmentStatusSchema,
  cleanup: z
    .strictObject({
      policy: z.enum(["manual", "idle", "scheduled", "on-exit"]).optional(),
      scheduledAt: z.iso.datetime().max(64).optional(),
      confirmed: z.boolean().optional(),
    })
    .optional(),
  continuity: z
    .strictObject({
      resumable: z.boolean(),
      mode: z.enum(["native", "replayed", "none"]).optional(),
    })
    .optional(),
  persistence: z
    .strictObject({
      durable: z.boolean(),
      scope: z.enum(["ephemeral", "session", "durable"]).optional(),
    })
    .optional(),
});
export type EnvironmentLifecycle = z.infer<typeof EnvironmentLifecycleSchema>;

/**
 * Credential-free network location. There is no field for a user, password,
 * token, or other secret, and the host and scheme reject embedded credentials.
 */
export const SafeEndpointSchema = z
  .strictObject({
    scheme: boundedIdentifierSchema.optional(),
    host: boundedIdentifierSchema,
    port: z.number().int().min(1).max(65_535).optional(),
    region: boundedIdentifierSchema.optional(),
  })
  .superRefine((endpoint, refinement) => {
    if (/[@/\s]|:\/\//.test(endpoint.host)) {
      refinement.addIssue({
        code: "custom",
        path: ["host"],
        message: "endpoint host must not carry credentials, a scheme, or a path",
      });
    }
    if (endpoint.scheme !== undefined && /[@:/\s]/.test(endpoint.scheme)) {
      refinement.addIssue({
        code: "custom",
        path: ["scheme"],
        message: "endpoint scheme must be a bare protocol name",
      });
    }
  });
export type SafeEndpoint = z.infer<typeof SafeEndpointSchema>;

/** Requested or effective compute shape, including an optional accelerator. */
export const ResourceProfileSchema = z.strictObject({
  cpu: z.number().finite().positive().optional(),
  memoryMb: z.number().int().positive().optional(),
  diskMb: z.number().int().positive().optional(),
  accelerator: z
    .strictObject({
      kind: boundedIdentifierSchema,
      count: z.number().int().positive(),
      memoryMb: z.number().int().positive().optional(),
    })
    .optional(),
});
export type ResourceProfile = z.infer<typeof ResourceProfileSchema>;

/** A point-in-time or peak resource sample. */
export const ResourceUseSampleSchema = z.strictObject({
  cpu: nonNegativeNumberSchema.optional(),
  memoryMb: nonNegativeNumberSchema.optional(),
  diskMb: nonNegativeNumberSchema.optional(),
  acceleratorMemoryMb: nonNegativeNumberSchema.optional(),
});
export type ResourceUseSample = z.infer<typeof ResourceUseSampleSchema>;

/** Where an environment was requested or verified to run. */
export const PlacementDescriptorSchema = z.strictObject({
  kind: z.enum(["local", "sandbox", "fleet", "provider"]),
  sandboxId: boundedIdentifierSchema.optional(),
  fleetId: boundedIdentifierSchema.optional(),
  machineId: boundedIdentifierSchema.optional(),
  region: boundedIdentifierSchema.optional(),
});
export type PlacementDescriptor = z.infer<typeof PlacementDescriptorSchema>;

/**
 * Token usage and cost for one execution. Bound to the shared {@link TokenUsage}
 * type so a change to the canonical shape is caught here.
 */
export const ModelUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative().optional(),
  cacheReadInputTokens: z.number().int().nonnegative().optional(),
  cacheCreationInputTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  cost: z.number().finite().nonnegative().optional(),
}) satisfies z.ZodType<TokenUsage>;

/** Provider compute cost charged for one environment. */
export const ComputeBillingSchema = z.strictObject({
  amount: nonNegativeNumberSchema,
  currency: boundedIdentifierSchema,
});
export type ComputeBilling = z.infer<typeof ComputeBillingSchema>;

/** Account plan, credits, quota, and billing period. */
export const AccountUsageSchema = z.strictObject({
  plan: observationOf(boundedIdentifierSchema).optional(),
  credits: observationOf(
    z.strictObject({
      remaining: nonNegativeNumberSchema,
      unit: boundedIdentifierSchema,
    }),
  ).optional(),
  quota: observationOf(
    z.strictObject({
      limit: nonNegativeNumberSchema,
      used: nonNegativeNumberSchema,
      remaining: nonNegativeNumberSchema,
      unit: boundedIdentifierSchema,
    }),
  ).optional(),
  period: observationOf(
    z.strictObject({
      start: z.iso.datetime().max(64),
      end: z.iso.datetime().max(64),
    }),
  ).optional(),
});
export type AccountUsage = z.infer<typeof AccountUsageSchema>;

/**
 * Optional normalized observation of one execution environment.
 *
 * `subject` is the always-known identity used to bind a live observation to its
 * replay. Every other surface is optional and freshness-tagged, so a provider
 * that reports nothing still validates and no absent value is a measured zero.
 */
export const AgentEnvironmentObservationSchema = z.strictObject({
  subject: ProviderIdentitySchema,
  capturedAt: z.iso.datetime().max(64),
  identity: observationOf(ProviderIdentitySchema).optional(),
  lifecycle: observationOf(EnvironmentLifecycleSchema).optional(),
  endpoint: observationOf(SafeEndpointSchema).optional(),
  placement: z
    .strictObject({
      requested: PlacementDescriptorSchema.optional(),
      verified: observationOf(PlacementDescriptorSchema).optional(),
    })
    .optional(),
  resources: z
    .strictObject({
      requested: ResourceProfileSchema.optional(),
      effective: observationOf(ResourceProfileSchema).optional(),
    })
    .optional(),
  resourceUse: z
    .strictObject({
      current: observationOf(ResourceUseSampleSchema).optional(),
      peak: observationOf(ResourceUseSampleSchema).optional(),
    })
    .optional(),
  modelUsage: observationOf(ModelUsageSchema).optional(),
  computeBilling: observationOf(ComputeBillingSchema).optional(),
  accountUsage: AccountUsageSchema.optional(),
});
export type AgentEnvironmentObservation = z.infer<
  typeof AgentEnvironmentObservationSchema
>;

function providerIdentityEquals(
  left: ProviderIdentity,
  right: ProviderIdentity,
): boolean {
  return (
    left.provider === right.provider &&
    left.environmentId === right.environmentId &&
    left.sessionId === right.sessionId &&
    left.backend === right.backend
  );
}

function observedIdentityMatches(
  left: AgentEnvironmentObservation["identity"],
  right: AgentEnvironmentObservation["identity"],
): boolean {
  if (left === undefined && right === undefined) return true;
  if (left === undefined || right === undefined) return false;
  if (left.state !== right.state) return false;
  const leftValue = "value" in left ? left.value : undefined;
  const rightValue = "value" in right ? right.value : undefined;
  if (leftValue === undefined && rightValue === undefined) return true;
  if (leftValue === undefined || rightValue === undefined) return false;
  const leftSource = "provenance" in left ? left.provenance.source : undefined;
  const rightSource =
    "provenance" in right ? right.provenance.source : undefined;
  return providerIdentityEquals(leftValue, rightValue) && leftSource === rightSource;
}

/**
 * A live observation and its replay must name the same environment and the
 * same observed identity and provenance source. Time and freshness may differ,
 * but the identifiers may not.
 */
export function agentEnvironmentObservationIdentityMatches(
  live: AgentEnvironmentObservation,
  replay: AgentEnvironmentObservation,
): boolean {
  const parsedLive = AgentEnvironmentObservationSchema.safeParse(live);
  const parsedReplay = AgentEnvironmentObservationSchema.safeParse(replay);
  if (!parsedLive.success || !parsedReplay.success) return false;
  return (
    providerIdentityEquals(parsedLive.data.subject, parsedReplay.data.subject) &&
    observedIdentityMatches(parsedLive.data.identity, parsedReplay.data.identity)
  );
}

const USERINFO_URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^/@\s]*@/i;

/**
 * Secret-shaped whole words. Matching whole words, not substrings, keeps a
 * token-count field such as `inputTokens` from reading as an auth token.
 */
const CREDENTIAL_WORDS = new Set([
  "token",
  "secret",
  "secrets",
  "password",
  "passwd",
  "passphrase",
  "credential",
  "credentials",
  "authorization",
  "bearer",
  "key",
  "keys",
]);

/** Split a key into lowercase words across camelCase and separators. */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter(Boolean);
}

/**
 * Report whether an observation payload carries a credential. A credential is a
 * secret-shaped object key or a string value with embedded userinfo. Contract
 * tests use this to prove the observation surface never transports a secret.
 */
export function observationContainsCredential(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (USERINFO_URL_PATTERN.test(current)) return true;
      continue;
    }
    if (current === null || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
      continue;
    }
    for (const [key, entry] of Object.entries(current)) {
      if (keyWords(key).some((word) => CREDENTIAL_WORDS.has(word))) return true;
      pending.push(entry);
    }
  }
  return false;
}

/** Throw when an observation payload carries a credential. */
export function assertObservationCredentialFree(value: unknown): void {
  if (observationContainsCredential(value)) {
    throw new Error("observation payload must not carry a credential");
  }
}

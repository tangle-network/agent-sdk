import { z } from "zod";
import { ownPropertyRecordSchema } from "./own-property-record.js";
import { agentCandidateSecretRefSchema } from "./agent-candidate-schema-common.js";
import { boundedIdentifierSchema, CONTRACT_MAX_ARRAY_LENGTH } from "./contract-limits.js";

/**
 * Declarations request authority. The issuer intersects scope/expiry with authenticated tenant,
 * issuer policy and lineage, without personal/team fallback, pinning immutable secret ID/revision.
 * Trusted lifecycle owners mint unpredictable per-epoch placeholders, never from secret/public
 * refs. JWT claims are synthetic public sub/aud/exp, without upstream identity or authority.
 * The sandbox is the isolation boundary; schemas cannot authenticate guest processes.
 */
const unique = (values: readonly string[]) => new Set(values).size === values.length;
const hostSchema = z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  "host must be an exact lowercase FQDN without scheme, port, wildcard or trailing dot");
const methodSchema = z.string().max(32).regex(/^[A-Z]+$/);
/** Paths are exact or terminal slash-star subtrees. /v1/* includes /v1/ and /v1/a, never /v1
 * or /v10. V1 rejects all percent encoding, dot segments, repeated slashes, query, fragments,
 * semicolons, backslashes, non-ASCII and controls, rather than normalizing ambiguous spellings.
 */
const pathSchema = z.string().max(2048).refine((path) => {
  const exact = path.endsWith("/*") ? path.slice(0, -1) : path;
  return /^\/[A-Za-z0-9._~!$&'()+,=:@/-]*$/.test(exact) && !exact.includes("//") &&
    !exact.split("/").some((part) => part === "." || part === "..");
}, "path must be canonical ASCII, exact or a terminal /* subtree");
const list = <T extends z.ZodType<string>>(schema: T) =>
  z.array(schema).min(1).max(CONTRACT_MAX_ARRAY_LENGTH).refine(unique, "selectors must be unique");
const envNameSchema = z.string().max(256).regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const headerSchema = z.string().max(256).regex(/^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/).refine((name) =>
  !["authorization", "proxy-authorization", "proxy-authenticate", "host", "connection", "keep-alive", "proxy-connection", "content-length", "transfer-encoding", "trailer", "upgrade", "te"].includes(name.toLowerCase()),
"use bearer/basic for Authorization; routing and framing headers cannot carry secrets");

/** Match complete components only. Selected header names are case-insensitive; duplicate fields
 * are refused before coalescing. Query names are case-sensitive after one strict UTF-8 percent
 * decode (+ means space); malformed encoding and duplicate decoded selector names are refused.
 * Never scan other query fields. Basic is one strict base64 value decoding to exactly public
 * username:placeholder; the username is printable ASCII without colon. Bearer is exactly
 * "Bearer SP placeholder". Embedded placeholders never match. Authority, TLS SNI and validated
 * destination must agree on the declared FQDN and effective port over HTTPS.
 */
export const ProxySecretPresentationSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("bearer") }),
  z.strictObject({ type: z.literal("basic"), username: z.string().min(1).max(256).regex(/^[\x21-\x39\x3b-\x7e]+$/) }),
  z.strictObject({ type: z.literal("header"), name: headerSchema }),
  z.strictObject({ type: z.literal("query"), name: z.string().max(256).regex(/^[A-Za-z0-9._~-]+$/) }),
]);
export type ProxySecretPresentation = z.infer<typeof ProxySecretPresentationSchema>;
export const ProxySecretScopeSchema = z.strictObject({
  hosts: list(hostSchema).readonly(), methods: list(methodSchema).readonly().optional(), paths: list(pathSchema).readonly().optional(),
});
export type ProxySecretScope = z.infer<typeof ProxySecretScopeSchema>;
const comparableScopeSchema = ProxySecretScopeSchema.strip();
export const ProxySecretBindingSchema = ProxySecretScopeSchema.extend({
  envName: envNameSchema,
  secretRef: agentCandidateSecretRefSchema.omit({ format: true }),
  presentation: ProxySecretPresentationSchema,
  placeholderFormat: z.enum(["opaque", "jwt"]).optional(),
  ttlSeconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});
export type ProxySecretBinding = z.infer<typeof ProxySecretBindingSchema>;
export const ProxySecretsSchema = z.array(ProxySecretBindingSchema).max(CONTRACT_MAX_ARRAY_LENGTH)
  .refine((bindings) => unique(bindings.map((binding) => binding.envName)), "proxy secret env names must be unique");
/** Host control, outside profile identity: strings pin API-verified parents; null is independent.
 * When present, keys must exactly cover the final selection.
 */
export const ProxySecretParentsSchema = ownPropertyRecordSchema(boundedIdentifierSchema.nullable(), { maxEntries: CONTRACT_MAX_ARRAY_LENGTH })
  .refine((parents) => Object.keys(parents).every((name) => envNameSchema.safeParse(name).success), "invalid parent selection keys");
export type ProxySecretParents = z.infer<typeof ProxySecretParentsSchema>;

/** Shape and totality only; the API verifies issuer authority and durable immutable pins. */
export function isProxySecretParentsTotal(
  bindings: readonly ProxySecretBinding[], parents: unknown,
): parents is ProxySecretParents {
  const selection = ProxySecretsSchema.safeParse(bindings);
  const parsed = ProxySecretParentsSchema.safeParse(parents);
  return selection.success && parsed.success && Object.keys(parsed.data).length === selection.data.length &&
    selection.data.every((binding) => Object.hasOwn(parsed.data, binding.envName));
}

/** API control-plane support; intentionally separate from the engine capability contract. */
export const ProxySecretDelegationCapabilitySchema = z.literal(1);

export const ProxySecretResolvedIdentitySchema = z.strictObject({
  tenantId: boundedIdentifierSchema, issuerId: boundedIdentifierSchema,
  secretId: boundedIdentifierSchema, revision: boundedIdentifierSchema,
});
export type ProxySecretResolvedIdentity = z.infer<typeof ProxySecretResolvedIdentitySchema>;
const timestamp = z.iso.datetime();
export const ProxySecretGrantSchema = z.strictObject({
  protocolVersion: z.literal(1), grantId: boundedIdentifierSchema,
  sandboxId: boundedIdentifierSchema, epoch: boundedIdentifierSchema,
  identity: ProxySecretResolvedIdentitySchema, scope: ProxySecretScopeSchema,
  presentation: ProxySecretPresentationSchema, placeholderFormat: z.enum(["opaque", "jwt"]),
  issuedAt: timestamp, expiresAt: timestamp, sourceExpiresAt: timestamp.optional(), parentGrantId: boundedIdentifierSchema.optional(),
}).refine((grant) => grant.parentGrantId !== grant.grantId && Date.parse(grant.expiresAt) > Date.parse(grant.issuedAt) &&
  (grant.sourceExpiresAt === undefined || Date.parse(grant.expiresAt) <= Date.parse(grant.sourceExpiresAt)), "grant expiry must follow issuance");
export type ProxySecretGrant = z.infer<typeof ProxySecretGrantSchema>;
const receiptShape = {
  protocolVersion: z.literal(1), sandboxId: boundedIdentifierSchema,
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  bindings: z.array(z.strictObject({ envName: envNameSchema, secretRef: agentCandidateSecretRefSchema.omit({ format: true }), grant: ProxySecretGrantSchema })).max(CONTRACT_MAX_ARRAY_LENGTH),
  proxyAcknowledged: z.literal(true),
};
/** proxy-installed is phase-two input, not dispatch authority; installed acknowledges both phases.
 * revoked confirms binding revocation, not upstream revocation. Receipts contain metadata only.
 */
export const ProxySecretReceiptSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...receiptShape, status: z.literal("proxy-installed"), materializationAcknowledged: z.literal(false) }),
  z.strictObject({ ...receiptShape, status: z.literal("installed"), materializationAcknowledged: z.literal(true) }),
  z.strictObject({ ...receiptShape, status: z.literal("revoked"), materializationAcknowledged: z.literal(true) }),
]).superRefine((receipt, ctx) => {
  if (!unique(receipt.bindings.map((binding) => binding.envName)) ||
      !unique(receipt.bindings.map((binding) => binding.grant.grantId))) {
    ctx.addIssue({ code: "custom", path: ["bindings"], message: "receipt binding names and grant IDs must be unique" });
  }
  if (receipt.bindings.some((binding) => binding.grant.sandboxId !== receipt.sandboxId)) {
    ctx.addIssue({ code: "custom", path: ["bindings"], message: "receipt grants must belong to its sandbox" });
  }
  if (new Set(receipt.bindings.map((binding) => binding.grant.epoch)).size > 1) {
    ctx.addIssue({ code: "custom", path: ["bindings"], message: "receipt grants must share one sandbox lifecycle epoch" });
  }
  if (receipt.status === "revoked" && receipt.bindings.length !== 0) {
    ctx.addIssue({ code: "custom", path: ["bindings"], message: "revoked receipt cannot retain bindings" });
  }
});
export type ProxySecretReceipt = z.infer<typeof ProxySecretReceiptSchema>;
/** Advertise only when served API, driver, host, proxy and materializer agree. Absence,
 * protocol skew, or unsupported driver/presentation/format refuses before resolution or launch.
 */
export const ProxySecretCapabilitiesSchema = z.strictObject({
  protocolVersion: z.literal(1), supportedDrivers: list(boundedIdentifierSchema),
  presentations: list(z.enum(["bearer", "basic", "header", "query"])),
  placeholderFormats: list(z.enum(["opaque", "jwt"])),
  enforcement: z.literal("exact"), transports: z.tuple([z.enum(["https:443", "https"])]),
  lifecycle: z.literal(true), placementReceiptRequired: z.literal(true),
});
export type ProxySecretCapabilities = z.infer<typeof ProxySecretCapabilitiesSchema>;
export const ProxySecretUpdateControlsSchema = z.strictObject({
  expectedProxySecretGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  requireInPlace: z.boolean().optional(),
});
export type ProxySecretUpdateControls = z.infer<typeof ProxySecretUpdateControlsSchema>;

/** Comparison cannot prove authorization, installation, freshness or lineage; owners cascade revocation. */
export function isProxySecretGrantAttenuation(parent: ProxySecretGrant, child: ProxySecretGrant): boolean {
  const p = ProxySecretGrantSchema.safeParse(parent), c = ProxySecretGrantSchema.safeParse(child);
  if (!p.success || !c.success) return false;
  const from = p.data, to = c.data;
  return to.parentGrantId === from.grantId &&
    Object.keys(from.identity).every((key) => from.identity[key as keyof ProxySecretResolvedIdentity] === to.identity[key as keyof ProxySecretResolvedIdentity]) &&
    proxySecretPresentationsEqual(from.presentation, to.presentation) && from.placeholderFormat === to.placeholderFormat &&
    Date.parse(to.issuedAt) >= Date.parse(from.issuedAt) && Date.parse(to.expiresAt) <= Date.parse(from.expiresAt) &&
    isProxySecretScopeAttenuation(from.scope, to.scope);
}

/** Early declaration guard only: matching public refs do not establish resolved authority. */
export function isProxySecretBindingAttenuation(parent: ProxySecretBinding, child: ProxySecretBinding): boolean {
  const p = ProxySecretBindingSchema.safeParse(parent), c = ProxySecretBindingSchema.safeParse(child);
  if (!p.success || !c.success) return false;
  const from = p.data, to = c.data;
  return from.secretRef.key === to.secretRef.key &&
    proxySecretPresentationsEqual(from.presentation, to.presentation) &&
    (from.placeholderFormat ?? "opaque") === (to.placeholderFormat ?? "opaque") &&
    (from.ttlSeconds === undefined || (to.ttlSeconds !== undefined && to.ttlSeconds <= from.ttlSeconds)) &&
    isProxySecretScopeAttenuation(from, to);
}

/** Intersect valid scopes; invalid/disjoint returns undefined. Omitted methods/paths are universal. */
export function intersectProxySecretScopes(left: ProxySecretScope, right: ProxySecretScope): ProxySecretScope | undefined {
  const p = comparableScopeSchema.safeParse(left), c = comparableScopeSchema.safeParse(right);
  if (!p.success || !c.success) return undefined;
  const from = p.data, to = c.data;
  const common = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
    a === undefined ? b : b === undefined ? a : a.filter((value) => b.includes(value));
  const paths = from.paths === undefined ? to.paths : to.paths === undefined ? from.paths : [...new Set(
    from.paths.flatMap((a) => to.paths!.flatMap((b) => pathContains(a, b) ? [b] : pathContains(b, a) ? [a] : [])),
  )];
  const parsed = ProxySecretScopeSchema.safeParse({ hosts: common(from.hosts, to.hosts), methods: common(from.methods, to.methods), paths });
  return parsed.success ? parsed.data : undefined;
}
const pathContains = (parent: string, child: string) => parent === child || (parent.endsWith("/*") && child.startsWith(parent.slice(0, -1)));

export function isProxySecretScopeAttenuation(parent: ProxySecretScope, child: ProxySecretScope): boolean {
  const p = comparableScopeSchema.safeParse(parent), c = comparableScopeSchema.safeParse(child);
  if (!p.success || !c.success) return false;
  return subset(p.data.hosts, c.data.hosts) && subset(p.data.methods, c.data.methods) &&
    (p.data.paths === undefined || (c.data.paths !== undefined && c.data.paths.every((path) =>
      p.data.paths!.some((allowed) => pathContains(allowed, path)))));
}

/** Header selectors compare case-insensitively; query selectors and Basic usernames are exact. */
export function proxySecretPresentationsEqual(left: ProxySecretPresentation, right: ProxySecretPresentation): boolean {
  const p = ProxySecretPresentationSchema.safeParse(left), c = ProxySecretPresentationSchema.safeParse(right);
  if (!p.success || !c.success) return false;
  const from = p.data, to = c.data;
  if (from.type !== to.type) return false;
  if (from.type === "header" && to.type === "header") return from.name.toLowerCase() === to.name.toLowerCase();
  if (from.type === "query" && to.type === "query") return from.name === to.name;
  if (from.type === "basic" && to.type === "basic") return from.username === to.username;
  return true;
}
function subset(parent: readonly string[] | undefined, child: readonly string[] | undefined): boolean {
  return parent === undefined || (child !== undefined && child.every((value) => parent.includes(value)));
}

/** Merge detached declarations; identical names require full agreement. Omission remains distinct
 * from explicit empty selection. Conflicts never expose declaration contents. */
export function mergeProxySecretBindings(...collections: readonly (readonly ProxySecretBinding[] | undefined)[]): ProxySecretBinding[] {
  const merged = new Map<string, z.infer<typeof ProxySecretBindingSchema>>();
  for (const binding of collections.flatMap((collection) => collection === undefined ? [] : ProxySecretsSchema.parse(collection))) {
    const existing = merged.get(binding.envName);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(binding)) {
      throw new Error("proxy-secret declarations disagree for the same environment name");
    }
    merged.set(binding.envName, binding);
  }
  return ProxySecretsSchema.parse([...merged.values()]);
}

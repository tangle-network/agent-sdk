import {
  ProxySecretCapabilitiesSchema, ProxySecretReceiptSchema, ProxySecretsSchema,
  isProxySecretScopeAttenuation, proxySecretPresentationsEqual,
  type AgentEnvironmentGetOptions, type CreateAgentEnvironmentInput, type ProxySecretBinding, type ProxySecretCapabilities, type ProxySecretReceipt,
} from "@tangle-network/agent-interface/environment-provider";
import { canonicalCandidateDigest, deepFreeze } from "@tangle-network/agent-interface";
import { awaitWithSignal } from "./tangle-contract-safety.js";
import type { SandboxInstanceLike } from "./tangle-types.js";

/** Provider-owned public declarations bind recovery; they contain no authority or values. */
export const PROXY_SECRETS_METADATA_KEY = "tangleProxySecrets";

export function captureProxySecrets(value: unknown): ProxySecretBinding[] {
  return deepFreeze(ProxySecretsSchema.parse(value));
}

export function proxySecretsFromInput(input: CreateAgentEnvironmentInput): ProxySecretBinding[] | undefined {
  const profile = typeof input.profile === "string" ? undefined : input.profile.proxySecrets;
  const direct = input.proxySecrets === undefined ? undefined : captureProxySecrets(input.proxySecrets);
  const declared = profile === undefined ? undefined : captureProxySecrets(profile);
  return mergeProxySecrets(declared, direct);
}

export function mergeProxySecrets(
  requested: ProxySecretBinding[] | undefined,
  selected: ProxySecretBinding[] | undefined,
): ProxySecretBinding[] | undefined {
  if (selected === undefined) return requested;
  const merged = new Map((requested ?? []).map((binding) => [binding.envName, binding]));
  for (const binding of selected) {
    const existing = merged.get(binding.envName);
    if (existing !== undefined && canonicalCandidateDigest(existing) !== canonicalCandidateDigest(binding)) {
      throw new Error("Tangle selected and requested proxy-secret declarations disagree");
    }
    merged.set(binding.envName, binding);
  }
  return captureProxySecrets([...merged.values()]);
}

export function assertProxySecretAliases(
  bindings: ProxySecretBinding[] | undefined,
  env: Record<string, string> | undefined,
  secrets: unknown,
): void {
  if (bindings !== undefined && secrets !== undefined && !Array.isArray(secrets)) {
    throw new Error("Tangle proxy-secret custody cannot use all or raw readable secret selection");
  }
  for (const binding of bindings ?? []) {
    for (const alias of [binding.envName, binding.secretRef.key]) {
      if (Object.hasOwn(env ?? {}, alias) || (Array.isArray(secrets) && secrets.includes(alias))) {
        throw new Error("Tangle proxy-secret reference or alias cannot receive raw readable secret delivery");
      }
    }
  }
}

export function proxySecretCapabilityFromDocument(document: unknown): ProxySecretCapabilities | undefined {
  const value = document !== null && typeof document === "object" && "proxySecrets" in document
    ? document.proxySecrets : undefined;
  const parsed = ProxySecretCapabilitiesSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function requireProxySecretCapability(document: unknown, bindings: ProxySecretBinding[]): void {
  const capability = proxySecretCapabilityFromDocument(document);
  if (capability === undefined || bindings.some((binding) =>
    !capability.presentations.includes(binding.presentation.type) ||
    !capability.placeholderFormats.includes(binding.placeholderFormat ?? "opaque"))) {
    throw new Error("Tangle peer does not prove the requested proxy-secret capability");
  }
}

/** Read live custody rather than trusting metadata, a cached declaration, or a caller option. */
export async function readProxySecretReceipt(
  box: SandboxInstanceLike,
  bindings: ProxySecretBinding[],
  operation?: { signal?: AbortSignal },
  previous?: ProxySecretReceipt,
  allowExpired = false,
): Promise<ProxySecretReceipt> {
  const document = await awaitWithSignal(box.capabilities?.(), operation?.signal);
  requireProxySecretCapability(document, bindings);
  if (box.egress === undefined) throw new Error("Tangle proxy-secret receipt readback is unavailable");
  const state = await awaitWithSignal(box.egress.get(operation), operation?.signal);
  return validateProxySecretReceipt(
    state !== null && typeof state === "object" && "proxySecretReceipt" in state ? state.proxySecretReceipt : undefined,
    box.id, bindings, previous, allowExpired,
  );
}

export function validateProxySecretReceipt(
  value: unknown,
  sandboxId: string,
  bindings: ProxySecretBinding[],
  previous?: ProxySecretReceipt,
  allowExpired = false,
): ProxySecretReceipt {
  const receipt = ProxySecretReceiptSchema.parse(value);
  if (receipt.sandboxId !== sandboxId ||
      (receipt.status !== "installed" && !(receipt.status === "revoked" && bindings.length === 0)) ||
      receipt.bindings.length !== bindings.length ||
      (previous !== undefined && receipt.generation < previous.generation)) {
    throw new Error("Tangle proxy-secret receipt does not prove current sandbox custody");
  }
  const now = Date.now();
  for (const binding of bindings) {
    const installed = receipt.bindings.find((entry) => entry.envName === binding.envName);
    const prior = previous?.bindings.find((entry) => entry.envName === binding.envName);
    if (installed === undefined) throw new Error("Tangle proxy-secret receipt dropped a declaration");
    if (canonicalCandidateDigest(installed.secretRef) !== canonicalCandidateDigest(binding.secretRef)) {
      throw new Error("Tangle proxy-secret receipt changes its requested reference");
    }
    const grant = installed.grant;
    const issuedAt = Date.parse(grant.issuedAt);
    const expiresAt = Date.parse(grant.expiresAt);
    if (grant.sandboxId !== sandboxId || issuedAt > now || (!allowExpired && expiresAt <= now) ||
        (binding.ttlSeconds !== undefined && expiresAt - issuedAt > binding.ttlSeconds * 1000) ||
        !proxySecretPresentationsEqual(binding.presentation, grant.presentation) ||
        grant.placeholderFormat !== (binding.placeholderFormat ?? "opaque") ||
        !isProxySecretScopeAttenuation(binding, grant.scope) ||
        (prior !== undefined && canonicalCandidateDigest(prior.grant.identity) !== canonicalCandidateDigest(grant.identity))) {
      throw new Error("Tangle proxy-secret receipt is expired, widened, or changes its resolved identity");
    }
  }
  return deepFreeze(receipt);
}

/** Explicit reconnect attachment reauthorizes through the existing trusted lifecycle owner. */
export async function rebindProxySecrets(
  box: SandboxInstanceLike,
  bindings: ProxySecretBinding[],
  options: AgentEnvironmentGetOptions,
): Promise<ProxySecretReceipt> {
  requireProxySecretCapability(await awaitWithSignal(box.capabilities?.(), options.signal), bindings);
  if (box.egress?.update === undefined) throw new Error("Tangle proxy-secret reconnect requires in-place egress update support");
  const state = await awaitWithSignal(box.egress.get(options), options.signal);
  const current = ProxySecretReceiptSchema.parse(
    state !== null && typeof state === "object" && "proxySecretReceipt" in state ? state.proxySecretReceipt : undefined,
  );
  if (current.sandboxId !== box.id || (options.expectedProxySecretGeneration !== undefined &&
      current.generation !== options.expectedProxySecretGeneration)) {
    throw new Error("Tangle proxy-secret reconnect generation or sandbox conflicts with current custody");
  }
  const updated = await awaitWithSignal(box.egress.update({
    proxySecrets: bindings, expectedProxySecretGeneration: current.generation, requireInPlace: true,
  }, options.signal ? { signal: options.signal } : undefined), options.signal);
  const receipt = validateProxySecretReceipt(
    updated !== null && typeof updated === "object" && "proxySecretReceipt" in updated ? updated.proxySecretReceipt : undefined,
    box.id, bindings,
  );
  if (receipt.generation < current.generation) throw new Error("Tangle proxy-secret reconnect returned stale custody");
  return readProxySecretReceipt(box, bindings, options, receipt);
}

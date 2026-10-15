import {
  ProxySecretCapabilitiesSchema, ProxySecretReceiptSchema, ProxySecretsSchema, ProxySecretParentsSchema, ProxySecretDelegationCapabilitySchema,
  isProxySecretParentsTotal, isProxySecretGrantAttenuation, type ProxySecretParents,
  isProxySecretScopeAttenuation, proxySecretPresentationsEqual, mergeProxySecretBindings,
  type AgentEnvironmentGetOptions, type CreateAgentEnvironmentInput, type ProxySecretBinding, type ProxySecretCapabilities, type ProxySecretReceipt,
} from "@tangle-network/agent-interface/environment-provider";
import { canonicalCandidateDigest, deepFreeze } from "@tangle-network/agent-interface";
import { awaitWithSignal } from "./tangle-contract-safety.js";
import type { SandboxClientLike, SandboxInstanceLike } from "./tangle-types.js";

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
  return requested === undefined && selected === undefined
    ? undefined : deepFreeze(mergeProxySecretBindings(requested, selected));
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
  control?: { client: SandboxClientLike; parents?: ProxySecretParents; readOnly?: true },
): Promise<ProxySecretReceipt> {
  const document = await awaitWithSignal(box.capabilities?.(), operation?.signal);
  requireProxySecretCapability(document, bindings);
  if (box.egress === undefined) throw new Error("Tangle proxy-secret receipt readback is unavailable");
  const state = await awaitWithSignal(box.egress.get(operation), operation?.signal);
  const receipt = validateProxySecretReceipt(
    state !== null && typeof state === "object" && "proxySecretReceipt" in state ? state.proxySecretReceipt : undefined,
    box.id, bindings, previous, allowExpired,
  );
  const parents = parentsFromState(state, bindings);
  if (control?.parents !== undefined && (parents === undefined ||
      canonicalCandidateDigest(parents) !== canonicalCandidateDigest(control.parents))) {
    throw new Error("Tangle parent map readback differs from admitted pins");
  }
  if (parents === undefined && receipt.bindings.some((entry) => entry.grant.parentGrantId !== undefined)) {
    throw new Error("Tangle delegated parent map readback is missing");
  }
  if (parents !== undefined) {
    if (control === undefined) throw new Error("Tangle parent map requires authenticated control-plane readback");
    requireProxySecretDelegation(await awaitWithSignal(control.client.capabilities?.(), operation?.signal));
    const parentReceipts = await readProxySecretParents(control.client, parents, operation, control.readOnly === true);
    for (const entry of receipt.bindings) {
      const parentId = parents[entry.envName];
      if (parentId === null) {
        if (entry.grant.parentGrantId !== undefined) throw new Error("Tangle explicit root pin returned a delegated grant");
      } else {
        const parent = parentReceipts.get(parentId!);
        if (parentId === box.id || parent === undefined || !parent.bindings.some((candidate) =>
          isProxySecretGrantAttenuation(candidate.grant, entry.grant))) {
          throw new Error("Tangle parent grant readback does not prove requested attenuation");
        }
      }
    }
    control.parents = parents;
  }
  return receipt;
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
      (previous !== undefined && (receipt.generation < previous.generation ||
        (receipt.generation === previous.generation && canonicalCandidateDigest(receipt) !== canonicalCandidateDigest(previous))))) {
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
        (prior !== undefined && (
          prior.grant.identity.tenantId !== grant.identity.tenantId ||
          prior.grant.identity.issuerId !== grant.identity.issuerId ||
          prior.grant.identity.secretId !== grant.identity.secretId ||
          (prior.grant.identity.revision !== grant.identity.revision && receipt.generation <= previous!.generation) ||
          (prior.grant.identity.revision === grant.identity.revision && prior.grant.sourceExpiresAt !== undefined &&
            (grant.sourceExpiresAt === undefined || Date.parse(grant.sourceExpiresAt) > Date.parse(prior.grant.sourceExpiresAt) ||
              expiresAt > Date.parse(prior.grant.sourceExpiresAt)))))) {
      throw new Error("Tangle proxy-secret receipt is expired, widened, or changes its resolved identity");
    }
  }
  return deepFreeze(receipt);
}

/** Capture a total map only after final profile and host declaration merging. */
export function captureProxySecretParents(bindings: ProxySecretBinding[] | undefined, parents: unknown): ProxySecretParents | undefined {
  if (parents === undefined) return undefined;
  if (bindings === undefined || !isProxySecretParentsTotal(bindings, parents)) {
    throw new Error("Tangle parent map must be total for the explicit proxy-secret selection");
  }
  return deepFreeze(ProxySecretParentsSchema.parse(parents));
}

export function parentsFromState(state: unknown, bindings: ProxySecretBinding[]): ProxySecretParents | undefined {
  return captureProxySecretParents(bindings,
    state !== null && typeof state === "object" && "proxySecretParents" in state ? state.proxySecretParents : undefined);
}

export function requireProxySecretDelegation(document: unknown): void {
  if (document === null || typeof document !== "object" ||
      !("proxySecretDelegation" in document) || !ProxySecretDelegationCapabilitySchema.safeParse(document.proxySecretDelegation).success) {
    throw new Error("Tangle peer does not prove API proxy-secret delegation capability");
  }
}

/** Same authenticated client, fresh control-plane reads, never a caller-supplied grant ID. */
export async function readProxySecretParents(
  client: SandboxClientLike, parents: ProxySecretParents, operation?: { signal?: AbortSignal },
  allowExpired = false,
): Promise<Map<string, ProxySecretReceipt>> {
  const receipts = new Map<string, ProxySecretReceipt>();
  for (const id of new Set(Object.values(parents))) {
    if (id === null) continue;
    const box = await awaitWithSignal(client.get?.(id, operation?.signal ? { signal: operation.signal } : undefined), operation?.signal);
    if (box?.id !== id || box.egress === undefined) throw new Error("Tangle parent sandbox readback is unavailable");
    const state = await awaitWithSignal(box.egress.get(operation), operation?.signal);
    if (state === null || typeof state !== "object" || !("proxySecrets" in state) || !("proxySecretReceipt" in state)) {
      throw new Error("Tangle parent custody readback is unavailable");
    }
    const bindings = captureProxySecrets(state.proxySecrets);
    const receipt = validateProxySecretReceipt(state.proxySecretReceipt, id, bindings, undefined, allowExpired);
    if (receipt.status !== "installed") throw new Error("Tangle parent sandbox is not installed");
    const pins = parentsFromState(state, bindings);
    if (pins === undefined && receipt.bindings.some((entry) => entry.grant.parentGrantId !== undefined)) {
      throw new Error("Tangle delegated parent map readback is missing");
    }
    receipts.set(id, receipt);
  }
  return receipts;
}

/** Explicit reconnect attachment reauthorizes through the existing trusted lifecycle owner. */
export async function rebindProxySecrets(
  box: SandboxInstanceLike,
  bindings: ProxySecretBinding[],
  options: AgentEnvironmentGetOptions,
  client: SandboxClientLike,
): Promise<ProxySecretParents | undefined> {
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
  const currentBindings = state !== null && typeof state === "object" && "proxySecrets" in state
    ? captureProxySecrets(state.proxySecrets) : undefined;
  if (currentBindings !== undefined) validateProxySecretReceipt(current, box.id, currentBindings, undefined, true);
  const priorParents = parentsFromState(state, currentBindings ?? []);
  if (priorParents === undefined && current.bindings.some((entry) => entry.grant.parentGrantId !== undefined)) {
    throw new Error("Tangle delegated parent map readback is missing");
  }
  let parents = captureProxySecretParents(bindings, options.proxySecretParents);
  if (parents !== undefined || priorParents !== undefined) {
    requireProxySecretDelegation(await awaitWithSignal(client.capabilities?.(), options.signal));
    const preserved: ProxySecretParents = {};
    for (const binding of bindings) {
      const prior = current.bindings.find((entry) => entry.envName === binding.envName &&
        canonicalCandidateDigest(entry.secretRef) === canonicalCandidateDigest(binding.secretRef));
      if (prior === undefined && parents === undefined) {
        throw new Error("Tangle new tuple in mapped replacement requires an explicit total parent map");
      }
      const priorPin = priorParents === undefined ? null : priorParents[binding.envName];
      if (prior !== undefined && parents !== undefined && parents[binding.envName] !== priorPin) {
        throw new Error("Tangle changing a parent pin requires acknowledged revocation first");
      }
      if (prior !== undefined) Object.defineProperty(preserved, binding.envName, { value: priorPin, enumerable: true });
    }
    parents ??= captureProxySecretParents(bindings, preserved);
    await readProxySecretParents(client, parents!, options);
  }
  const updated = await awaitWithSignal(box.egress.update({
    proxySecrets: bindings, ...(parents === undefined ? {} : { proxySecretParents: parents }),
    expectedProxySecretGeneration: current.generation, requireInPlace: true,
  }, options.signal ? { signal: options.signal } : undefined), options.signal);
  const receipt = validateProxySecretReceipt(
    updated !== null && typeof updated === "object" && "proxySecretReceipt" in updated ? updated.proxySecretReceipt : undefined,
    box.id, bindings,
  );
  if (bindings.length === 0 && receipt.status !== "revoked") {
    throw new Error("Tangle proxy-secret reconnect requires confirmed revocation for an empty selection");
  }
  if (receipt.generation < current.generation) throw new Error("Tangle proxy-secret reconnect returned stale custody");
  // A newly observed map also opts into the API protocol, even on an old-root request.
  const returnedParents = parentsFromState(updated, bindings);
  if (returnedParents !== undefined) {
    requireProxySecretDelegation(await awaitWithSignal(client.capabilities?.(), options.signal));
  }
  // Validate the mutation response itself as well as a subsequent current GET.
  if (parents !== undefined && canonicalCandidateDigest(returnedParents ?? null) !== canonicalCandidateDigest(parents)) {
    throw new Error("Tangle parent map PATCH readback differs from admitted pins");
  }
  parents ??= returnedParents;
  const control = { client, ...(parents === undefined ? {} : { parents }) };
  await readProxySecretReceipt(box, bindings, options, receipt, false, control);
  return control.parents;
}

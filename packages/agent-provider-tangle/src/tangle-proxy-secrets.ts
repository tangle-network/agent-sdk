import { ProxySecretsSchema, mergeProxySecretBindings,
  type CreateAgentEnvironmentInput, type ProxySecretBinding } from "@tangle-network/agent-interface/environment-provider";
import { canonicalCandidateDigest, deepFreeze } from "@tangle-network/agent-interface";
import { boundedIdentifier, MAX_ARRAY_LENGTH } from "./tangle-contract-safety.js";
import type { CreateSandboxOptions, SecretBinding } from "@tangle-network/sandbox";

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
  if (bindings !== undefined && secrets !== undefined && !Array.isArray(secrets)) throw new Error("Tangle proxy-secret custody cannot use all or raw readable secret selection");
  for (const binding of bindings ?? []) {
    for (const alias of [binding.envName, binding.secretRef.key]) {
      if (Object.hasOwn(env ?? {}, alias) || (Array.isArray(secrets) && secrets.some((entry) => typeof entry === "string" ? entry === alias : entry?.name === alias && "exposeInBox" in entry))) {
        throw new Error("Tangle proxy-secret reference or alias cannot receive raw readable secret delivery");
      }
    }
  }
}

/** Lower portable declarations to the single host binding actually served by Sandbox. */
export function sandboxSecretBindings(
  secrets: CreateAgentEnvironmentInput["secrets"] | "all",
  bindings?: readonly ProxySecretBinding[],
  env?: Record<string, string>,
): Exclude<CreateSandboxOptions["secrets"], "all"> {
  assertProxySecretAliases(bindings === undefined ? undefined : [...bindings], env, secrets);
  const lowered = (bindings ?? []).map((binding) => {
    if (binding.hosts.length !== 1 || binding.methods !== undefined || binding.paths !== undefined ||
        binding.presentation.type === "query" || binding.placeholderFormat === "jwt" ||
        binding.ttlSeconds !== undefined || binding.envName !== binding.secretRef.key) {
      throw new Error("Tangle host bindings cannot enforce aliases, multiple hosts, methods, paths, query, jwt or expiry");
    }
    return { name: binding.secretRef.key, host: binding.hosts[0]!,
      header: binding.presentation.type === "header" ? binding.presentation.name : "Authorization" };
  });
  if (secrets === undefined && bindings === undefined) return undefined;
  if (secrets !== undefined && !Array.isArray(secrets)) throw new Error("Tangle secrets must be stored names or host bindings");
  const entries = new Map<string, string | SecretBinding>();
  for (const entry of [...(secrets ?? []), ...lowered]) {
    const name = typeof entry === "string" ? entry : entry.name;
    boundedIdentifier(name, "Tangle stored-secret name");
    if (typeof entry !== "string") {
      if (("host" in entry ? Object.keys(entry).some((key) => !["name", "host", "header"].includes(key)) ||
          typeof entry.host !== "string" || entry.host.length > 253 ||
          !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(entry.host) ||
          (entry.header !== undefined && (typeof entry.header !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(entry.header))) :
          Object.keys(entry).some((key) => !["name", "exposeInBox"].includes(key)) || entry.exposeInBox !== true) ||
          Object.hasOwn(env ?? {}, name)) throw new Error("Invalid or shadowed Tangle secret selection");
    }
    const previous = entries.get(name);
    if (previous !== undefined && sandboxSecretBindingIdentity(previous) !== sandboxSecretBindingIdentity(entry)) throw new Error("Conflicting Tangle secret delivery");
    entries.set(name, entry);
  }
  if (entries.size > MAX_ARRAY_LENGTH) throw new Error("Tangle stored-secret selection exceeds its bound");
  return [...entries.values()];
}

export const sandboxSecretBindingIdentity = (entry: string | SecretBinding): string => canonicalCandidateDigest(
  typeof entry !== "string" && "host" in entry ? { ...entry, header: (entry.header ?? "Authorization").toLowerCase() } : entry,
);

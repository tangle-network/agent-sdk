import { ProxySecretsSchema, mergeProxySecretBindings,
  type CreateAgentEnvironmentInput, type ProxySecretBinding } from "@tangle-network/agent-interface/environment-provider";
import { canonicalCandidateDigest, deepFreeze } from "@tangle-network/agent-interface";

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
  for (const binding of bindings ?? []) {
    for (const alias of [binding.envName, binding.secretRef.key]) {
      if (Object.hasOwn(env ?? {}, alias) || (Array.isArray(secrets) && secrets.some((entry) => {
        if (typeof entry === "string" || entry?.name !== alias) return false;
        if ("exposeInBox" in entry) return true;
        if (!("host" in entry)) return false;
        const header = (entry.header ?? "Authorization").toLowerCase();
        return !binding.hosts.includes(entry.host) || binding.presentation.type === "query" ||
          header !== (binding.presentation.type === "header" ? binding.presentation.name.toLowerCase() : "authorization");
      }))) {
        throw new Error("Tangle proxy-secret scope conflicts with readable or legacy delivery");
      }
    }
  }
}

/** Legacy selection identity stays at the compatibility boundary. */
export const sandboxSecretBindingIdentity = (entry: Extract<CreateAgentEnvironmentInput["secrets"], unknown[]>[number]): string => canonicalCandidateDigest(
  typeof entry !== "string" && "host" in entry ? { ...entry, header: (entry.header ?? "Authorization").toLowerCase() } : entry,
);

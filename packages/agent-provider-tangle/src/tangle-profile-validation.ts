import { validateProfileForCreate } from "@tangle-network/sandbox";
import type { AgentEnvironmentProvider } from "@tangle-network/agent-interface/environment-provider";
import type { TangleModelCredentialResolver } from "./tangle-types.js";

type ProfileValidator = NonNullable<AgentEnvironmentProvider["validateProfile"]>;

/** Validate the normalized profile once through the SDK and account owner's read-only route check. */
export function tangleProfileValidator(supplied?: ProfileValidator, resolver?: TangleModelCredentialResolver): ProfileValidator {
  return async (profile) => {
    const result = await supplied?.(profile);
    if (result && !result.ok) return result;
    const candidate = result?.normalizedProfile ?? profile;
    // Without a harness the SDK still runs create's inline-mount and size checks; it skips only materialization.
    const verdict = typeof candidate !== "string" ? validateProfileForCreate(candidate, candidate.harness!) : undefined;
    const issues = verdict && !verdict.ok ? [{level:"error" as const,code:verdict.error.code,message:verdict.error.message}] : [];
    if (issues.length) return {ok:false,issues};
    const route = await resolver?.validate?.(candidate);
    return {ok:route?.ok ?? true,issues:[...(route?.issues ?? []),...(result?.issues ?? [])],
      ...(result?.normalizedProfile ? {normalizedProfile:result.normalizedProfile} : {})};
  };
}

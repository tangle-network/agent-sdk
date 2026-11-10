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
    // Without a harness the SDK still runs create's inline-mount and size checks; it skips only materialization. The published Sandbox SDK's types carry a frozen harness union, and its client validator passes an unknown harness unchecked; the Sandbox API refuses it at create (400 VALIDATION_ERROR). The two harness casts bridge that union: delete when @tangle-network/sandbox publishes with agent-interface >= 5.10.22 (https://github.com/tangle-network/agent-container/issues/18386).
    const verdict = typeof candidate !== "string" ? validateProfileForCreate(candidate as typeof candidate & Pick<Parameters<typeof validateProfileForCreate>[0], "harness">, candidate.harness as Parameters<typeof validateProfileForCreate>[1]) : undefined;
    const issues = verdict && !verdict.ok ? [{level:"error" as const,code:verdict.error.code,message:verdict.error.message}] : [];
    if (issues.length) return {ok:false,issues};
    const route = await resolver?.validate?.(candidate);
    return {ok:route?.ok ?? true,issues:[...(route?.issues ?? []),...(result?.issues ?? [])],
      ...(result?.normalizedProfile ? {normalizedProfile:result.normalizedProfile} : {})};
  };
}

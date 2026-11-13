import { splitInlineProfileFileMounts, validateDeferredProfileFileMounts, validateProfileForCreate } from "@tangle-network/sandbox";
import type { AgentEnvironmentProvider } from "@tangle-network/agent-interface/environment-provider";
import type { TangleModelCredentialResolver } from "./tangle-types.js";

type ProfileValidator = NonNullable<AgentEnvironmentProvider["validateProfile"]>;

/** Validate the normalized profile once through the SDK and account owner's read-only route check. */
export function tangleProfileValidator(supplied?: ProfileValidator, resolver?: TangleModelCredentialResolver): ProfileValidator {
  return async (profile) => {
    const result = await supplied?.(profile);
    if (result && !result.ok) return result;
    const candidate = result?.normalizedProfile ?? profile;
    // Sandbox >= 1.0.393 requires a harness and refuses none; a profile without one gets only create's inline-mount checks, since materialization needs a harness. The profile cast covers the SDK's own bundled harness/seats union (https://github.com/tangle-network/agent-container/issues/18386).
    const verdict = typeof candidate === "string" ? undefined
      : candidate.harness ? validateProfileForCreate(candidate as typeof candidate & Pick<Parameters<typeof validateProfileForCreate>[0], "harness" | "seats">, candidate.harness)
      : mountVerdict(candidate);
    const issues = verdict && !verdict.ok ? [{level:"error" as const,code:verdict.error.code,message:verdict.error.message}] : [];
    if (issues.length) return {ok:false,issues};
    const route = await resolver?.validate?.(candidate);
    return {ok:route?.ok ?? true,issues:[...(route?.issues ?? []),...(result?.issues ?? [])],
      ...(result?.normalizedProfile ? {normalizedProfile:result.normalizedProfile} : {})};
  };
}

function mountVerdict(profile: object): { ok: true } | { ok: false; error: { code: string; message: string } } {
  try {
    const typed = profile as Parameters<typeof splitInlineProfileFileMounts>[0];
    validateDeferredProfileFileMounts(splitInlineProfileFileMounts(typed).deferredFiles, { failOnError: typed.resources?.failOnError });
    return { ok: true };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { ok: false, error: { code: typeof code === "string" ? code : "VALIDATION_ERROR", message: error instanceof Error ? error.message : String(error) } };
  }
}

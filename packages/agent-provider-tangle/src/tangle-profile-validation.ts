import { splitInlineProfileFileMounts, validateDeferredProfileFileMounts, validateProfileForCreate } from "@tangle-network/sandbox";
import type { AgentEnvironmentProvider } from "@tangle-network/agent-interface/environment-provider";
import type { TangleModelCredentialResolver } from "./tangle-types.js";

type ProfileValidator = NonNullable<AgentEnvironmentProvider["validateProfile"]>;
type SdkHarnessFields = Pick<Parameters<typeof validateProfileForCreate>[0], "harness" | "seats">;
type MountVerdict = { ok: true } | { ok: false; error: { code: string; message: string } };

/** Validate the normalized profile once through the SDK and account owner's read-only route check. */
export function tangleProfileValidator(supplied?: ProfileValidator, resolver?: TangleModelCredentialResolver): ProfileValidator {
  return async (profile) => {
    const result = await supplied?.(profile);
    if (result && !result.ok) return result;
    const candidate = result?.normalizedProfile ?? profile;
    // Sandbox >= 1.0.393 refuses a missing harness; without one only create's inline-mount checks apply.
    // The profile cast covers the SDK's bundled harness/seats union (https://github.com/tangle-network/agent-container/issues/18386).
    const verdict = typeof candidate === "string" ? undefined
      : candidate.harness ? validateProfileForCreate(candidate as typeof candidate & SdkHarnessFields, candidate.harness)
      : mountVerdict(candidate);
    const issues = verdict && !verdict.ok ? [{level:"error" as const,code:verdict.error.code,message:verdict.error.message}] : [];
    if (issues.length) return {ok:false,issues};
    const route = await resolver?.validate?.(candidate);
    return {ok:route?.ok ?? true,issues:[...(route?.issues ?? []),...(result?.issues ?? [])],
      ...(result?.normalizedProfile ? {normalizedProfile:result.normalizedProfile} : {})};
  };
}

function mountVerdict(profile: object): MountVerdict {
  try {
    const typed = profile as Parameters<typeof splitInlineProfileFileMounts>[0];
    const { deferredFiles } = splitInlineProfileFileMounts(typed);
    validateDeferredProfileFileMounts(deferredFiles, { failOnError: typed.resources?.failOnError });
    return { ok: true };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { code: typeof code === "string" ? code : "VALIDATION_ERROR", message } };
  }
}

import { validateProfileForCreate } from "@tangle-network/sandbox";
import type { AgentEnvironmentProvider } from "@tangle-network/agent-interface/environment-provider";
import type { TangleModelCredentialResolver } from "./tangle-types.js";

type ProfileValidator = NonNullable<AgentEnvironmentProvider["validateProfile"]>;

/** One SDK pre-box verdict, the account owner's route check, then caller policy. */
export function tangleProfileValidator(supplied?: ProfileValidator, resolver?: TangleModelCredentialResolver): ProfileValidator {
  return async (profile) => {
    const verdict = typeof profile !== "string" && profile.harness ? validateProfileForCreate(profile, profile.harness) : undefined;
    const issues = verdict && !verdict.ok ? [{ level: "error" as const, code: verdict.error.code, message: verdict.error.message }] : [];
    if (issues.length) return { ok: false, issues };
    const route = await resolver?.validate?.(profile);
    if (route && !route.ok) return route;
    const result = supplied ? await supplied(profile) : undefined;
    return {
      ok: result?.ok ?? true,
      issues: [...(route?.issues ?? []), ...(result?.issues ?? [])],
      ...(result?.normalizedProfile ? { normalizedProfile: result.normalizedProfile } : {}),
    };
  };
}

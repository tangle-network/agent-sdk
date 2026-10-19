import { splitInlineProfileFileMounts, validateDeferredProfileFileMounts } from "@tangle-network/sandbox";
import type { AgentProfileValidationIssue } from "@tangle-network/agent-interface";
import type { AgentEnvironmentProvider } from "@tangle-network/agent-interface/environment-provider";

type ProfileValidator = NonNullable<AgentEnvironmentProvider["validateProfile"]>;

/**
 * The Sandbox SDK's own create-time check of a profile's inline file mounts, run before any box
 * exists. create() refuses the same input, but only once a caller has already committed to the
 * spawn; a coordinator that checks first can return the refusal to whoever asked for the worker.
 */
function profileFileMountIssues(profile: Parameters<ProfileValidator>[0]): AgentProfileValidationIssue[] {
  if (typeof profile === "string") return [];
  const { deferredFiles } = splitInlineProfileFileMounts(profile as Parameters<typeof splitInlineProfileFileMounts>[0]);
  if (!deferredFiles.length) return [];
  try {
    validateDeferredProfileFileMounts(deferredFiles);
    return [];
  } catch (error) {
    const detail = error as { code?: unknown; path?: unknown; message?: unknown };
    return [{
      level: "error",
      code: typeof detail.code === "string" ? detail.code : "PROFILE_FILE_MOUNT_INVALID",
      message: typeof detail.message === "string" ? detail.message : String(error),
      ...(typeof detail.path === "string" ? { path: detail.path } : {}),
    }];
  }
}

/** The provider's validateProfile: the Sandbox mount check, then any caller-supplied validator. */
export function tangleProfileValidator(supplied?: ProfileValidator): ProfileValidator {
  return async (profile) => {
    const issues = profileFileMountIssues(profile);
    const result = supplied ? await supplied(profile) : undefined;
    return {
      ok: !issues.some((issue) => issue.level === "error") && (result?.ok ?? true),
      issues: [...issues, ...(result?.issues ?? [])],
      ...(result?.normalizedProfile ? { normalizedProfile: result.normalizedProfile } : {}),
    };
  };
}

import * as Sandbox from "@tangle-network/sandbox";
import { splitInlineProfileFileMounts, validateDeferredProfileFileMounts } from "@tangle-network/sandbox";
import type { AgentProfileValidationIssue } from "@tangle-network/agent-interface";
import type { AgentEnvironmentProvider } from "@tangle-network/agent-interface/environment-provider";

type ProfileValidator = NonNullable<AgentEnvironmentProvider["validateProfile"]>;

/** The Sandbox SDK's create-time check of a profile's inline file mounts, run before any box exists. */
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

/** Sandbox's pre-box verdict where the SDK ships it; oversize only warns: this provider stages a large profile's files. */
function profileVerdictIssues(profile: Parameters<ProfileValidator>[0]): AgentProfileValidationIssue[] {
  const verdict = (Sandbox as { validateProfileForCreate?: (p: unknown, h: string) => { ok: boolean; error?: { code?: string; message: string } } }).validateProfileForCreate;
  const harness = typeof profile === "string" ? undefined : (profile as { harness?: string }).harness;
  const result = verdict && harness ? verdict(profile, harness) : undefined;
  if (!result || result.ok || !result.error) return [];
  const code = result.error.code ?? "PROFILE_UNSUPPORTED";
  return [{ level: code === "PAYLOAD_TOO_LARGE" ? "warning" : "error", code, message: result.error.message }];
}

/** The provider's validateProfile: the Sandbox mount check and pre-box verdict, then any caller-supplied validator. */
export function tangleProfileValidator(supplied?: ProfileValidator): ProfileValidator {
  return async (profile) => {
    const issues = [...profileFileMountIssues(profile), ...profileVerdictIssues(profile)];
    const result = supplied ? await supplied(profile) : undefined;
    return {
      ok: !issues.some((issue) => issue.level === "error") && (result?.ok ?? true),
      issues: [...issues, ...(result?.issues ?? [])],
      ...(result?.normalizedProfile ? { normalizedProfile: result.normalizedProfile } : {}),
    };
  };
}

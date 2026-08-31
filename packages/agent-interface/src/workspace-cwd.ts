import { z } from "zod";
import {
  relativePathSafetyIssues,
  type RelativePathSafetyIssue,
} from "./agent-candidate-schema-common.js";

/** Maximum number of UTF-16 code units accepted in a portable workspace cwd. */
export const MAX_WORKSPACE_CWD_LENGTH = 4_096;

const workspaceCwdIssueMessages: Partial<
  Record<RelativePathSafetyIssue, string>
> = {
  absolute: "Workspace cwd must be relative",
  backslash: "Workspace cwd must use POSIX separators",
  "control-character": "Workspace cwd cannot contain control characters",
  "parent-traversal": "Workspace cwd cannot leave the workspace root",
  "malformed-unicode": "Workspace cwd must contain well-formed Unicode",
};

function normalizeWorkspaceCwd(value: string): string {
  const segments = value
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  return segments.join("/") || ".";
}

/**
 * Validate and canonicalize a repository-relative POSIX workspace path.
 *
 * The returned path never starts with `./`, contains duplicate separators, or
 * leaves the workspace root. Use `.` for the repository root.
 */
export const workspaceCwdSchema = z
  .string()
  .min(1)
  .max(MAX_WORKSPACE_CWD_LENGTH)
  .superRefine((value, refinement) => {
    for (const issue of relativePathSafetyIssues(value)) {
      const message = workspaceCwdIssueMessages[issue];
      if (message === undefined) continue;
      refinement.addIssue({
        code: "custom",
        message,
      });
    }
  })
  .transform(normalizeWorkspaceCwd);

/** Validate and return the canonical form of a workspace cwd. */
export function canonicalWorkspaceCwd(value: string): string {
  return workspaceCwdSchema.parse(value);
}

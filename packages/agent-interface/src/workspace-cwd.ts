import { z } from "zod";

/** Maximum number of UTF-16 code units accepted in a portable workspace cwd. */
export const MAX_WORKSPACE_CWD_LENGTH = 4_096;

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

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
    if (value.startsWith("/")) {
      refinement.addIssue({
        code: "custom",
        message: "Workspace cwd must be relative",
      });
    }
    if (value.includes("\\")) {
      refinement.addIssue({
        code: "custom",
        message: "Workspace cwd must use POSIX separators",
      });
    }
    if (hasControlCharacter(value)) {
      refinement.addIssue({
        code: "custom",
        message: "Workspace cwd cannot contain control characters",
      });
    }
    if (value.split("/").includes("..")) {
      refinement.addIssue({
        code: "custom",
        message: "Workspace cwd cannot leave the workspace root",
      });
    }
  })
  .transform(normalizeWorkspaceCwd);

/** Validate and return the canonical form of a workspace cwd. */
export function canonicalWorkspaceCwd(value: string): string {
  return workspaceCwdSchema.parse(value);
}

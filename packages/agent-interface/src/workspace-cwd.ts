import { z } from "zod";
import {
  pathSafetyIssues,
  relativePathSafetyIssues,
  type PathSafetyIssue,
  type RelativePathSafetyIssue,
} from "./agent-candidate-schema-common.js";

/** Maximum number of UTF-16 code units accepted in a workspace cwd path. */
export const MAX_WORKSPACE_CWD_LENGTH = 4_096;

export type WorkspaceCwdBase = "repository" | "host";

export type WorkspaceCwd =
  | { base: "repository"; path: string }
  | { base: "host"; path: string };

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

const pathIssueMessages: Record<PathSafetyIssue, string> = {
  "control-character": "Workspace cwd cannot contain control characters",
  "malformed-unicode": "Workspace cwd must contain well-formed Unicode",
};

const repositoryWorkspaceCwdPathSchema = z
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

const hostWorkspaceCwdPathSchema = z
  .string()
  .max(MAX_WORKSPACE_CWD_LENGTH)
  .superRefine((value, refinement) => {
    for (const issue of pathSafetyIssues(value)) {
      refinement.addIssue({
        code: "custom",
        message: pathIssueMessages[issue],
      });
    }
  });

/**
 * Validate and canonicalize an explicitly based workspace path.
 *
 * Repository paths never start with `./`, contain duplicate separators, or
 * leave the workspace root. Host paths preserve native separators and values.
 */
export const workspaceCwdSchema = z.discriminatedUnion("base", [
  z.strictObject({
    base: z.literal("repository"),
    path: repositoryWorkspaceCwdPathSchema,
  }),
  z.strictObject({
    base: z.literal("host"),
    path: hostWorkspaceCwdPathSchema,
  }),
]) satisfies z.ZodType<WorkspaceCwd>;

/** Validate and return the canonical form of a workspace cwd. */
export function canonicalWorkspaceCwd(value: WorkspaceCwd): WorkspaceCwd {
  return workspaceCwdSchema.parse(value);
}

/** Return a provider path only when its explicit base is supported. */
export function workspaceCwdPathForBase(
  value: WorkspaceCwd | undefined,
  base: WorkspaceCwdBase,
  providerLabel: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.base !== base) {
    throw new Error(
      `${providerLabel} supports workspace cwd base "${base}", not "${value.base}"`,
    );
  }
  return value.path;
}

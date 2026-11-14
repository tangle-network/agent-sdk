import { z } from "zod";
import { relativePathSafetyIssues } from "./agent-candidate-schema-common.js";
import { boundedIdentifierSchema, boundedStringSchema } from "./contract-limits.js";

/** One caller-declared output, relative to the managed workspace root, not a process cwd. */
export interface AgentFileOutputPolicy {
  name: string;
  path: string;
}

export const AgentFileOutputPolicySchema = z.strictObject({
  name: boundedIdentifierSchema,
  path: boundedStringSchema.refine((path) =>
    path.length > 0 && relativePathSafetyIssues(path).length === 0 &&
    path.split("/").every((part) => part.length > 0 && part !== "."),
  "File output must name one canonical relative managed-workspace path"),
}) satisfies z.ZodType<AgentFileOutputPolicy>;


import { z } from "zod";
import type {
  AgentCandidateArtifactRef,
  AgentCandidateEmbeddedArtifact,
  AgentCandidateFileMount,
  AgentCandidateGitHubResource,
  AgentCandidateInlineResource,
  AgentCandidateIpfsLocator,
  AgentCandidateResourceRef,
  AgentCandidateResources,
  AgentCandidateS3Locator,
} from "./agent-candidate.js";
import {
  agentCandidateGitHubRepositorySchema,
  gitObjectSchema,
  isSafeRelativePath,
  isWellFormedUnicode,
  looksLikeCredential,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";

const base64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const base64Alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const s3BucketPattern = /^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const awsRegionPattern = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const ipfsCidPattern = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/;

function decodedBase64ByteLength(value: string): number {
  if (value.length === 0) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function hasCanonicalBase64Padding(value: string): boolean {
  if (value.endsWith("==")) {
    const index = base64Alphabet.indexOf(value.at(-3) ?? "");
    return index >= 0 && (index & 0x0f) === 0;
  }
  if (value.endsWith("=")) {
    const index = base64Alphabet.indexOf(value.at(-2) ?? "");
    return index >= 0 && (index & 0x03) === 0;
  }
  return true;
}

export const agentCandidateS3LocatorSchema = z
  .object({
    kind: z.literal("s3"),
    bucket: z.string().regex(s3BucketPattern),
    key: z
      .string()
      .refine(
        (value) =>
          isSafeRelativePath(value, false) && !looksLikeCredential(value),
        "S3 key must be a canonical relative artifact path",
      ),
    region: z.string().regex(awsRegionPattern).optional(),
  })
  .strict() satisfies z.ZodType<AgentCandidateS3Locator>;

export const agentCandidateIpfsLocatorSchema = z
  .object({
    kind: z.literal("ipfs"),
    cid: z.string().regex(ipfsCidPattern),
    path: z
      .string()
      .refine(
        (value) =>
          isSafeRelativePath(value, false) && !looksLikeCredential(value),
        "IPFS path must be a canonical relative artifact path",
      )
      .optional(),
  })
  .strict() satisfies z.ZodType<AgentCandidateIpfsLocator>;

export const agentCandidateArtifactLocatorSchema = z.discriminatedUnion(
  "kind",
  [agentCandidateS3LocatorSchema, agentCandidateIpfsLocatorSchema],
);

export const agentCandidateArtifactRefSchema = z
  .object({
    locator: agentCandidateArtifactLocatorSchema,
    sha256: sha256DigestSchema,
    byteLength: z.number().int().nonnegative(),
  })
  .strict() satisfies z.ZodType<AgentCandidateArtifactRef>;

export const agentCandidateEmbeddedArtifactSchema = z
  .object({
    encoding: z.literal("base64"),
    content: z.string().regex(base64Pattern),
    sha256: sha256DigestSchema,
    byteLength: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine(validateEmbeddedArtifact) satisfies z.ZodType<AgentCandidateEmbeddedArtifact>;

export function validateEmbeddedArtifact(
  artifact: { content: string; byteLength: number },
  ctx: z.RefinementCtx,
): void {
  if (!hasCanonicalBase64Padding(artifact.content)) {
    ctx.addIssue({
      code: "custom",
      path: ["content"],
      message: "base64 content must use canonical zero padding bits",
    });
  }
  if (decodedBase64ByteLength(artifact.content) !== artifact.byteLength) {
    ctx.addIssue({
      code: "custom",
      path: ["byteLength"],
      message: "byteLength must match the decoded base64 content",
    });
  }
}

export const agentCandidateInlineResourceSchema = z
  .object({
    kind: z.literal("inline"),
    name: z.string().min(1).refine(isWellFormedUnicode),
    content: z.string().refine(isWellFormedUnicode),
    sha256: sha256DigestSchema,
    byteLength: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((resource, ctx) => {
    if (new TextEncoder().encode(resource.content).byteLength !== resource.byteLength) {
      ctx.addIssue({
        code: "custom",
        path: ["byteLength"],
        message: "byteLength must match UTF-8 content",
      });
    }
  }) satisfies z.ZodType<AgentCandidateInlineResource>;

export const agentCandidateGitHubResourceSchema = z
  .object({
    kind: z.literal("github"),
    repository: agentCandidateGitHubRepositorySchema,
    path: z
      .string()
      .refine(
        (value) => isSafeRelativePath(value, false),
        "path must be a canonical repository-relative path",
      ),
    commit: gitObjectSchema,
    name: z.string().min(1).refine(isWellFormedUnicode).optional(),
    sha256: sha256DigestSchema,
    byteLength: z.number().int().nonnegative(),
  })
  .strict() satisfies z.ZodType<AgentCandidateGitHubResource>;

export const agentCandidateResourceRefSchema = z.discriminatedUnion("kind", [
  agentCandidateInlineResourceSchema,
  agentCandidateGitHubResourceSchema,
]) satisfies z.ZodType<AgentCandidateResourceRef>;

export const agentCandidateFileMountSchema = z
  .object({
    path: z
      .string()
      .refine(
        (value) => isSafeRelativePath(value, false),
        "mount path must be a canonical workspace-relative path",
      ),
    resource: agentCandidateResourceRefSchema,
    executable: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<AgentCandidateFileMount>;

export const agentCandidateResourcesSchema = z
  .object({
    files: z.array(agentCandidateFileMountSchema).optional(),
    tools: z.array(agentCandidateResourceRefSchema).optional(),
    skills: z.array(agentCandidateResourceRefSchema).optional(),
    agents: z.array(agentCandidateResourceRefSchema).optional(),
    commands: z.array(agentCandidateResourceRefSchema).optional(),
    instructions: z
      .union([z.string().refine(isWellFormedUnicode), agentCandidateResourceRefSchema])
      .optional(),
    failOnError: z.literal(true),
  })
  .strict() satisfies z.ZodType<AgentCandidateResources>;

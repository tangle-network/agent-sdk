import { sha256 } from "@noble/hashes/sha256";
import { z } from "zod";
import type {
  AgentCandidateConfigValue,
  AgentCandidateGitHubRepository,
  Sha256Digest,
} from "./agent-candidate.js";

const sha256Pattern = /^sha256:[a-f0-9]{64}$/;
const gitObjectPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const headerNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const mediaTypePattern =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const githubComponentPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const secretNamePattern =
  /(?:^|[_-])(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|credentials?|authorization|cookie|database[_-]?url|dsn|pat)(?:[_-]|$)/i;
const obviousSecretValuePattern =
  /(?:\b(?:sk|gh[pousr]|github_pat|AKIA)[-_A-Za-z0-9]{12,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+)/;
const controlCharacterPattern = /[\u0000-\u001f\u007f]/;
const reservedWorkspaceRoots = new Set([".git", ".sidecar"]);
const shellNames = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "cmd",
  "cmd.exe",
  "powershell",
  "pwsh",
]);
const blockedHostnames = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google",
]);

export const sha256DigestSchema = z
  .string()
  .regex(sha256Pattern) as z.ZodType<Sha256Digest>;
export const gitObjectSchema = z.string().regex(gitObjectPattern);
export const environmentNameSchema = z.string().regex(environmentNamePattern);
export const headerNameSchema = z.string().regex(headerNamePattern);
export const agentCandidateMediaTypeSchema = z.string().regex(mediaTypePattern);

export function sha256Utf8(value: string): Sha256Digest {
  const bytes = sha256(new TextEncoder().encode(value));
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function isSafeRelativePath(value: string, allowDot: boolean): boolean {
  if (
    value.length === 0 ||
    controlCharacterPattern.test(value) ||
    !isWellFormedUnicode(value) ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.includes("\\") ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  if (value === ".") return allowDot;
  const parts = value.split("/");
  return (
    parts.every((part) => part.length > 0 && part !== "." && part !== "..") &&
    !parts.some((part) => reservedWorkspaceRoots.has(part))
  );
}

export function isSafeExecutable(value: string): boolean {
  if (
    value.length === 0 ||
    controlCharacterPattern.test(value) ||
    !isWellFormedUnicode(value) ||
    /\s/.test(value) ||
    value.includes("\\") ||
    !/^[A-Za-z0-9._+/-]+$/.test(value)
  ) {
    return false;
  }
  const parts = value.split("/");
  if (value.startsWith("/")) parts.shift();
  if (
    parts.length === 0 ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    return false;
  }
  return !shellNames.has(parts.at(-1)?.toLowerCase() ?? "");
}

export function isObviouslyPrivateHostname(rawHostname: string): boolean {
  const literal = rawHostname.toLowerCase().replace(/^\[|\]$/g, "");
  let hostname = literal;
  try {
    const parsed = new URL(
      `http://${literal.includes(":") ? `[${literal}]` : literal}/`,
    );
    hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  } catch {
    // Non-URL hostnames remain ordinary DNS names and are handled below.
  }
  if (blockedHostnames.has(hostname) || hostname.endsWith(".localhost")) {
    return true;
  }
  if (hostname.includes(":")) {
    const firstHextet = hostname.split(":", 1)[0] ?? "";
    if (
      hostname === "::" ||
      hostname === "::1" ||
      hostname.startsWith("fe8") ||
      hostname.startsWith("fe9") ||
      hostname.startsWith("fea") ||
      hostname.startsWith("feb") ||
      firstHextet.startsWith("fc") ||
      firstHextet.startsWith("fd") ||
      hostname.startsWith("::ffff:")
    ) {
      return true;
    }
  }
  const parts = hostname.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b] = parts;
  if (a === undefined || b === undefined) {
    return false;
  }
  if (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  ) {
    return true;
  }
  return false;
}

export function isCanonicalJsonValue(
  value: unknown,
  ancestors = new Set<object>(),
): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return isWellFormedUnicode(value);
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;

  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    return false;
  }

  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    return value.every((entry) =>
      isCanonicalJsonValue(entry, nextAncestors),
    );
  }
  return Object.entries(value).every(
    ([key, entry]) =>
      isWellFormedUnicode(key) && isCanonicalJsonValue(entry, nextAncestors),
  );
}

function hasCredentialBearingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "") return true;
    return [...url.searchParams.keys()].some((key) => secretNamePattern.test(key));
  } catch {
    return false;
  }
}

export function looksLikeCredential(value: string): boolean {
  return obviousSecretValuePattern.test(value) || hasCredentialBearingUrl(value);
}

function isPublicConfigValue(value: string): boolean {
  return (
    !controlCharacterPattern.test(value) &&
    isWellFormedUnicode(value) &&
    !looksLikeCredential(value)
  );
}

export const agentCandidateConfigValueSchema = z
  .object({
    kind: z.literal("public"),
    value: z
      .string()
      .refine(
        isPublicConfigValue,
        "candidate config cannot carry credentials; the evaluator owns model authorization",
      ),
  })
  .strict() satisfies z.ZodType<AgentCandidateConfigValue>;

function configRecordSchema(keySchema: z.ZodString) {
  return z
    .record(keySchema, agentCandidateConfigValueSchema)
    .superRefine((config, ctx) => {
      for (const [name, value] of Object.entries(config)) {
        if (secretNamePattern.test(name)) {
          ctx.addIssue({
            code: "custom",
            path: [name],
            message: "candidate config cannot declare credential-bearing names",
          });
        }
      }
    });
}

export const environmentConfigSchema = configRecordSchema(
  environmentNameSchema,
);
export const headerConfigSchema = configRecordSchema(headerNameSchema);

export const candidateMetadataSchema = z
  .record(z.string(), z.unknown())
  .superRefine((metadata, ctx) => {
    if (hasSensitiveMetadataKey(metadata)) {
      ctx.addIssue({
        code: "custom",
        message: "metadata must not contain credential-bearing keys",
      });
    }
  });

function hasSensitiveMetadataKey(
  value: unknown,
  ancestors = new Set<object>(),
): boolean {
  if (value === null || typeof value !== "object" || ancestors.has(value)) {
    return false;
  }
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => hasSensitiveMetadataKey(entry, nextAncestors));
  }
  for (const [key, entry] of Object.entries(value)) {
    if (secretNamePattern.test(key)) return true;
    if (hasSensitiveMetadataKey(entry, nextAncestors)) return true;
  }
  return false;
}

export const agentCandidateGitHubRepositorySchema = z
  .object({
    kind: z.literal("github"),
    owner: z
      .string()
      .regex(githubComponentPattern)
      .refine((value) => value !== "." && value !== ".."),
    repo: z
      .string()
      .regex(githubComponentPattern)
      .refine((value) => value !== "." && value !== ".."),
  })
  .strict() satisfies z.ZodType<AgentCandidateGitHubRepository>;

export function addDuplicateIssues(
  values: readonly string[] | undefined,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  if (!values) return;
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      ctx.addIssue({
        code: "custom",
        path: [...path, index],
        message: `duplicate value '${value}'`,
      });
    }
    seen.add(value);
  }
}

export function sameGitObjectFormat(...values: string[]): boolean {
  return new Set(values.map((value) => value.length)).size === 1;
}

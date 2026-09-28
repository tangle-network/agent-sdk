import { createHash } from "node:crypto";
import type { AgentEnvironment } from "@tangle-network/agent-interface/environment-provider";
import type { SandboxInstanceLike } from "./tangle-types.js";

const handles = new WeakMap<AgentEnvironment, { box: SandboxInstanceLike; sessions: Map<string, Set<string>> }>();
const blockedNames = new Set([".ssh", ".config", ".claude", ".codex", ".opencode", ".env", ".env.local", ".npmrc", ".sidecar"]);
const MAX_ENTRIES = 100_000;
const MAX_EVENTS = 100_000;

interface WorkspaceEntryMetadata {
  path: string;
  type: "file" | "directory" | "symlink";
  sizeBytes: number;
  mode: number;
  owner: string | null;
  group: string | null;
  modifiedAt: string | null;
  accessedAt: string | null;
  /** The Sandbox file listing does not disclose a symbolic link target. */
  symlinkTarget: null;
}

export interface TangleEnvironmentEvidenceOptions {
  executionId: string;
  /** An exact expected session when the execution was reattached after provider restart. */
  nativeSessionId?: string | null;
  maxBytes: number;
  signal?: AbortSignal;
}

export interface TangleEnvironmentEvidence {
  files: Array<{ path: string; bytes: Uint8Array; mode: number }>;
  provenance: {
    provider: string;
    environmentId: string;
    executionId: string;
    workspaceScope: "environment";
    workspaceRoot: ".";
    capturedAt: string;
    entries: WorkspaceEntryMetadata[];
    excludedPaths: Array<WorkspaceEntryMetadata & { reason: "credential-path" | "symlink" | "runtime-owned" }>;
    workspace: { scannedFiles: number; scannedDirectories: number; reportedFiles: number; reportedDirectories: number; complete: true };
    sessions: Array<{ id: string; executionId: string; transportEvents: "complete" | "unavailable"; eventCount: number; messageCount: number; messageScope: "session"; nativeRollout: "complete" | "unavailable"; nativeSessionId: string | null; nativeReason: string | null; nativeSha256: string | null; nativeBytes: number | null }>;
    missing: string[];
  };
}

export function bindTangleEvidenceEnvironment(environment: AgentEnvironment, box: SandboxInstanceLike): void {
  handles.set(environment, { box, sessions: new Map() });
}

export function noteTangleSession(environment: AgentEnvironment, sessionId: string, executionId?: string): void {
  const state = handles.get(environment);
  if (!state || !executionId || !safeIdentifier(sessionId) || !safeIdentifier(executionId)) return;
  const executions = state.sessions.get(sessionId) ?? new Set<string>();
  executions.add(executionId);
  state.sessions.set(sessionId, executions);
}

/** Export a reconciled customer workspace inventory and exact attributed transport replay. */
export async function captureTangleEnvironmentEvidence(
  environment: AgentEnvironment,
  options: TangleEnvironmentEvidenceOptions,
): Promise<TangleEnvironmentEvidence> {
  const state = handles.get(environment);
  if (!state || state.box.id !== environment.id) throw new Error("Tangle evidence requires a live provider environment handle");
  if (!safeIdentifier(options.executionId)) throw new Error("Tangle evidence requires an exact execution id");
  if (options.nativeSessionId != null && !safeIdentifier(options.nativeSessionId)) throw new Error("Tangle evidence native session id is invalid");
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) throw new Error("Tangle evidence maxBytes must be positive");
  const { box } = state;
  const fs = box.fs;
  if (!fs?.list || !fs.usage || !fs.readBatch) throw new Error("Tangle evidence requires workspace list, usage, and binary batch read");
  options.signal?.throwIfAborted();
  const usage = await fs.usage(".");
  if (!usage.complete || usage.skippedEntries !== 0) throw new Error("Tangle workspace usage scan is incomplete");
  if (usage.sizeBytes > options.maxBytes) throw new Error("Tangle workspace exceeds evidence byte limit");
  const files: TangleEnvironmentEvidence["files"] = [];
  const metadata: WorkspaceEntryMetadata[] = [];
  const seenPaths = new Set<string>();
  const excludedPaths: TangleEnvironmentEvidence["provenance"]["excludedPaths"] = [];
  const stack = ["."];
  let scannedFiles = 0;
  let scannedDirectories = 0;
  let scannedEntries = 0;
  let scannedSize = 0;
  let capturedBytes = 0;
  while (stack.length) {
    options.signal?.throwIfAborted();
    const directory = stack.pop()!;
    const entries = await fs.list(directory, { all: true, long: true });
    if (!Array.isArray(entries)) throw new Error("Tangle workspace list is malformed");
    for (const entry of entries) {
      if (++scannedEntries > MAX_ENTRIES) throw new Error("Tangle workspace entry limit exceeded");
      const path = canonicalEntryPath(entry.path);
      if (seenPaths.has(path)) throw new Error("Tangle workspace inventory repeats a path");
      seenPaths.add(path);
      const expectedParent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
      if (expectedParent !== directory || entry.name !== path.split("/").at(-1)) throw new Error("Tangle workspace list returned a path outside its parent");
      if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error("Tangle workspace entry has invalid size");
      const item = entryMetadata(path, entry);
      metadata.push(item);
      if (path.split("/").includes(".sidecar")) {
        excludedPaths.push({ ...item, reason: "runtime-owned" });
        continue;
      }
      if (entry.isDir && !entry.isSymlink) {
        scannedDirectories++;
        if (path.split("/").some((part) => blockedNames.has(part))) {
          excludedPaths.push({ ...item, reason: "credential-path" });
        }
        stack.push(path);
        continue;
      }
      if (!entry.isFile && !entry.isSymlink) throw new Error("Tangle workspace contains an unsupported file type");
      scannedFiles++;
      scannedSize += entry.size;
      if (entry.isSymlink) {
        excludedPaths.push({ ...item, reason: "symlink" });
        continue;
      }
      if (path.split("/").some((part) => blockedNames.has(part) || /^\.env\./.test(part))) {
        excludedPaths.push({ ...item, reason: "credential-path" });
        continue;
      }
      const result = await fs.readBatch([path], { encoding: "base64" });
      if (result.errors.length || result.files.length !== 1 || result.files[0]?.path !== path || result.files[0]?.encoding !== "base64") {
        throw new Error(`Tangle evidence could not read workspace file ${path}`);
      }
      const read = result.files[0];
      const bytes = Buffer.from(read.content, "base64");
      if (bytes.byteLength !== entry.size || read.size !== entry.size || bytes.toString("base64") !== read.content) {
        throw new Error(`Tangle evidence workspace file changed or was truncated: ${path}`);
      }
      if (read.hash && read.hash.replace(/^sha256:/, "") !== createHash("sha256").update(bytes).digest("hex")) {
        throw new Error(`Tangle evidence workspace file hash mismatch: ${path}`);
      }
      files.push({ path, bytes, mode: entry.permissions & 0o777 });
      capturedBytes += bytes.byteLength;
    }
  }
  if (scannedFiles !== usage.fileCount || scannedDirectories !== usage.directoryCount || scannedSize !== usage.sizeBytes) {
    throw new Error("Tangle workspace inventory does not match the complete usage scan");
  }
  const sessionIds = new Set<string>([...state.sessions.entries()]
    .filter(([, executions]) => executions.has(options.executionId))
    .map(([id]) => id));
  if (options.nativeSessionId) sessionIds.add(options.nativeSessionId);
  const sessions: TangleEnvironmentEvidence["provenance"]["sessions"] = [];
  const missing: string[] = [];
  if (excludedPaths.length) missing.push(`Workspace omitted ${excludedPaths.length} credential paths or symlinks; inspect excludedPaths`);
  if (sessionIds.size === 0) missing.push("No exact Sandbox session id was attributed to this execution");
  for (const id of [...sessionIds].sort()) {
    const session = box.session?.(id);
    if (!session?.events || !session.messages) {
      missing.push(`Sandbox session ${id} has no replay and message export`);
      continue;
    }
    const status = await session.status();
    if (status === null) {
      missing.push(`Sandbox session ${id} no longer exists`);
      continue;
    }
    const events: unknown[] = [];
    for await (const event of session.events({ since: "0", executionId: options.executionId, signal: options.signal })) {
      options.signal?.throwIfAborted();
      if (events.length >= MAX_EVENTS) throw new Error("Tangle event replay limit exceeded");
      if (typeof event.data?.executionId === "string" && event.data.executionId !== options.executionId) {
        throw new Error("Tangle event replay returned an unrelated execution");
      }
      if (typeof event.data?.runtimeSessionId === "string" && event.data.runtimeSessionId !== id) {
        throw new Error("Tangle event replay returned an unrelated session");
      }
      capturedBytes += Buffer.byteLength(JSON.stringify(event));
      if (capturedBytes > options.maxBytes) throw new Error("Tangle evidence exceeds byte limit");
      events.push(event);
    }
    const messages: unknown[] = [];
    for (let offset = 0; ; offset += 1000) {
      options.signal?.throwIfAborted();
      if (offset >= MAX_EVENTS) throw new Error("Tangle message pagination limit exceeded");
      const page = await session.messages({ limit: 1000, offset });
      if (!Array.isArray(page) || page.length > 1000) throw new Error("Tangle session message page is malformed");
      capturedBytes += Buffer.byteLength(JSON.stringify(page));
      if (capturedBytes > options.maxBytes) throw new Error("Tangle evidence exceeds byte limit");
      messages.push(...page);
      if (page.length < 1000) break;
    }
    const bytes = Buffer.from(JSON.stringify({ kind: "tangle-session-transport.v1", environmentId: environment.id, sessionId: id, executionId: options.executionId, status, events, messages, messageScope: "session" }));
    if (files.reduce((sum, file) => sum + file.bytes.byteLength, 0) + bytes.byteLength > options.maxBytes) throw new Error("Tangle evidence exceeds byte limit");
    capturedBytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0) + bytes.byteLength;
    files.push({ path: `__retention__/sessions/${id}.json`, bytes, mode: 0o600 });
    const rollout = await session.nativeRollout?.();
    let nativeRollout: "complete" | "unavailable" = "unavailable";
    let nativeSessionId: string | null = null;
    let nativeReason: string | null = "native-export-capability-absent";
    let nativeSha256: string | null = null;
    let nativeBytes: number | null = null;
    if (rollout !== undefined) {
      if (rollout.sessionId !== id) throw new Error("Tangle native rollout returned an unrelated session");
      if (rollout.status === "captured") {
        if (rollout.backendType !== "opencode" || rollout.format !== "opencode-session-export-json" || !safeIdentifier(rollout.nativeSessionId)) {
          throw new Error("Tangle native rollout identity or format is invalid");
        }
        const native = Buffer.from(rollout.contentBase64, "base64");
        const digest = `sha256:${createHash("sha256").update(native).digest("hex")}`;
        if (native.byteLength !== rollout.sizeBytes || native.toString("base64") !== rollout.contentBase64 || digest !== rollout.sha256) {
          throw new Error("Tangle native rollout bytes do not match the server receipt");
        }
        const decoded: unknown = JSON.parse(native.toString("utf8"));
        if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Tangle native rollout is not a JSON object");
        if (capturedBytes + native.byteLength > options.maxBytes) throw new Error("Tangle evidence exceeds byte limit");
        files.push({ path: `__retention__/sessions/${id}.native.json`, bytes: native, mode: 0o600 });
        capturedBytes += native.byteLength;
        nativeRollout = "complete";
        nativeSessionId = rollout.nativeSessionId;
        nativeReason = null;
        nativeSha256 = digest;
        nativeBytes = native.byteLength;
      } else {
        if (!safeIdentifier(rollout.reason)) throw new Error("Tangle native rollout unavailability reason is invalid");
        nativeSessionId = rollout.nativeSessionId ?? null;
        nativeReason = rollout.reason;
      }
    }
    sessions.push({ id, executionId: options.executionId, transportEvents: events.length ? "complete" : "unavailable", eventCount: events.length, messageCount: messages.length, messageScope: "session", nativeRollout, nativeSessionId, nativeReason, nativeSha256, nativeBytes });
    if (!events.length) missing.push(`Sandbox session ${id} returned no events for execution ${options.executionId}`);
    if (nativeRollout !== "complete") missing.push(`Native harness rollout for Sandbox session ${id} is unavailable: ${nativeReason}`);
  }
  const provenance: TangleEnvironmentEvidence["provenance"] = {
    provider: environment.provider,
    environmentId: environment.id,
    executionId: options.executionId,
    workspaceScope: "environment",
    workspaceRoot: ".",
    capturedAt: new Date().toISOString(),
    entries: metadata.sort((a, b) => a.path.localeCompare(b.path)),
    excludedPaths,
    workspace: { scannedFiles, scannedDirectories, reportedFiles: usage.fileCount, reportedDirectories: usage.directoryCount, complete: true },
    sessions,
    missing,
  };
  const provenanceBytes = Buffer.from(JSON.stringify({ kind: "tangle-evidence-provenance.v1", ...provenance }));
  if (capturedBytes + provenanceBytes.byteLength > options.maxBytes) throw new Error("Tangle evidence exceeds byte limit");
  files.push({ path: "__retention__/provenance.json", bytes: provenanceBytes, mode: 0o600 });
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), provenance };
}

function safeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function canonicalEntryPath(value: string): string {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0")) throw new Error("Tangle workspace entry path is unsafe");
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("Tangle workspace entry path is not canonical");
  if (parts[0] === "__retention__") throw new Error("Tangle workspace conflicts with reserved retention path");
  return value;
}

function entryMetadata(path: string, entry: {
  size: number;
  isDir: boolean;
  isFile: boolean;
  isSymlink: boolean;
  permissions: number;
  owner?: string;
  group?: string;
  modTime?: Date | string;
  accessTime?: Date | string;
}): WorkspaceEntryMetadata {
  if (!Number.isInteger(entry.permissions) || entry.permissions < 0) throw new Error("Tangle workspace entry has invalid mode");
  const type = entry.isSymlink ? "symlink" : entry.isDir ? "directory" : entry.isFile ? "file" : undefined;
  if (!type) throw new Error("Tangle workspace entry has unknown type");
  return {
    path,
    type,
    sizeBytes: entry.size,
    mode: entry.permissions & 0o777,
    owner: entry.owner ?? null,
    group: entry.group ?? null,
    modifiedAt: isoTime(entry.modTime),
    accessedAt: isoTime(entry.accessTime),
    symlinkTarget: null,
  };
}

function isoTime(value: Date | string | undefined): string | null {
  if (value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Tangle workspace entry has invalid timestamp");
  return date.toISOString();
}

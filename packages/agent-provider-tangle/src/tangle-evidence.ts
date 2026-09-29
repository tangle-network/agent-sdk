import { createHash } from "node:crypto";
import { parseBackendType } from "@tangle-network/sandbox";
import type { AgentProfile, HarnessType } from "@tangle-network/agent-interface";
import type { AgentEnvironment } from "@tangle-network/agent-interface/environment-provider";
import type { NativeCaptureProofLike, SandboxClientLike, SandboxInstanceLike, TangleEvidenceAttemptLike, TangleRawEvidenceLike } from "./tangle-types.js";
import { nativeCaptureHarnesses, requireNativeCaptureProof } from "./tangle-native-capture-proof.js";

const handles = new WeakMap<AgentEnvironment, { box: SandboxInstanceLike; sessions: Map<string, Set<string>> }>();
const blockedNames = new Set([".ssh", ".config", ".claude", ".codex", ".opencode", ".env", ".env.local", ".npmrc", ".sidecar"]);
const MAX_ENTRIES = 100_000;
const MAX_EVENTS = 100_000;
const verifiedCapabilities = new WeakSet<object>();

export interface TangleEvidenceCapabilities {
  readonly workspaceCaptureV1: true;
  readonly nativeSessionCaptureV1: boolean;
  readonly nativeSessionCaptureHarnesses: readonly HarnessType[];
  readonly sidecarImageDigest: string;
}

/** Read a deployment guarantee once, before Runtime starts creating environments. */
export async function readTangleEvidenceCapabilities(client: SandboxClientLike): Promise<TangleEvidenceCapabilities> {
  if (typeof client.evidenceCapabilities !== "function") throw new Error("Tangle deployment has no pre-create evidence capability query");
  const document = await client.evidenceCapabilities();
  if (document?.workspaceCaptureV1 !== true || typeof document.nativeSessionCaptureV1 !== "boolean" ||
      !/^sha256:[0-9a-f]{64}$/.test(document.sidecarImageDigest ?? "")) {
    throw new Error("Tangle deployment has not proven complete workspace and native session capture for next-create placement");
  }
  const verified = Object.freeze({
    workspaceCaptureV1: true as const,
    nativeSessionCaptureV1: document.nativeSessionCaptureV1,
    nativeSessionCaptureHarnesses: nativeCaptureHarnesses(document.nativeSessionCaptureHarnesses),
    sidecarImageDigest: document.sidecarImageDigest as string,
  });
  verifiedCapabilities.add(verified);
  return verified;
}

/** Require the exact profile harness in the deployment's verified admission list. */
export function assertTangleEvidenceProfileCapability(document: TangleEvidenceCapabilities, profile: AgentProfile): void {
  if (!verifiedCapabilities.has(document)) throw new Error("Tangle evidence capability was not read from the deployment");
  if (!profile.harness) throw new Error("Tangle complete native session capture requires an exact profile harness");
  parseBackendType(profile.harness);
  if (!document.nativeSessionCaptureHarnesses.includes(profile.harness)) {
    throw new Error(`Tangle deployment has not proven native session capture for harness ${JSON.stringify(profile.harness)}`);
  }
}

/** Refuse unsupported or unproven native trace retention before Sandbox create. */
export async function assertTangleEvidenceCapability(client: SandboxClientLike, profile: AgentProfile): Promise<void> {
  const document = await readTangleEvidenceCapabilities(client);
  assertTangleEvidenceProfileCapability(document, profile);
}

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
  harness: NonNullable<AgentProfile["harness"]>;
  /** Optional local image ID to compare with the running sidecar image. */
  expectedSidecarImageDigest?: string;
  /** Require raw session bytes to match this box's current verified create proof. */
  requireNativeSessionCapture?: boolean;
  /** Exact Sandbox session id when execution was reattached after provider restart. */
  sandboxSessionId?: string | null;
  maxBytes: number;
  signal?: AbortSignal;
}

export interface TangleSandboxEvidenceOptions extends Omit<TangleEnvironmentEvidenceOptions, "sandboxSessionId"> {
  sandboxSessionIds: readonly string[];
  /** Every observed execution on each retained Sandbox session. */
  sessionExecutionIds?: Readonly<Record<string, readonly string[]>>;
  /** Exact relative worker directory. Defaults to the Sandbox workspace root. */
  workspaceRoot?: string;
}

export interface TangleEnvironmentEvidence {
  files: Array<{ path: string; bytes: Uint8Array; mode: number }>;
  provenance: {
    provider: string;
    environmentId: string;
    executionId: string;
    captureProof?: NativeCaptureProofLike;
    workspaceScope: "environment";
    workspaceRoot: string;
    capturedAt: string;
    entries: WorkspaceEntryMetadata[];
    excludedPaths: Array<WorkspaceEntryMetadata & { reason: "credential-path" | "symlink" | "runtime-owned" }>;
    workspace: { scannedFiles: number; scannedDirectories: number; reportedFiles: number; reportedDirectories: number; complete: true };
    attempts: TangleEvidenceAttemptLike[];
    sessions: Array<{
      id: string;
      executionId: string;
      executionIds: string[];
      eventCountsByExecutionId: Record<string, number>;
      backendType: string;
      sidecarImageDigest: string | null;
      sidecarBundleRevision: string | null;
      transportEvents: "complete" | "unavailable";
      eventCount: number;
      messageCount: number;
      messageScope: "session";
      nativeSessionId: string | null;
      nativeReason: string | null;
      nativeStore: {
        scope: "session";
        roots: Array<{ scope: "session-home" | "workspace-session"; path: string }>;
        inventory: {
          scannedFiles: number; reportedFiles: number; excludedFiles: number;
          scannedDirectories: number; reportedDirectories: number; excludedDirectories: number;
          scannedSymlinks: number; reportedSymlinks: number; excludedSymlinks: number;
          skippedEntries: number;
        } | null;
        complete: boolean;
        entries: Array<{
          rootScope: "session-home" | "workspace-session"; path: string; kind: "file" | "directory" | "symlink";
          mode: number; uid: number; gid: number; mtimeMs: number; ctimeMs: number; sizeBytes: number;
          sha256: string | null; linkTarget: string | null;
        }>;
        excludedPaths: Array<{
          rootScope: "session-home" | "workspace-session"; path: string; kind: "file" | "directory" | "symlink";
          mode: number; uid: number; gid: number; mtimeMs: number; ctimeMs: number; sizeBytes: number;
          reason: "credential";
        }>;
      };
      processStreams: {
        complete: boolean; streamCount: number; processCount: number; terminalCount: number;
        stdinBytes: number; stdoutBytes: number; stderrBytes: number; protocolBytes: number;
        source?: { path: string; sizeBytes: number; sha256: string };
        terminals: Array<{ processId: string; executionId?: string; ordinal?: number; providerSessionId?: string; sequence: number; at: string; result: {
          code: number | null; signal: string | null; timedOut: boolean; timeoutReason: string | null;
          captureError: string | null; spawnError?: string;
        } }>;
      };
      nativeEvents: { scope: "execution"; complete: boolean; count: number };
    }>;
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

/** Export an environment through its retained Sandbox handle. */
export async function captureTangleEnvironmentEvidence(
  environment: AgentEnvironment,
  options: TangleEnvironmentEvidenceOptions,
): Promise<TangleEnvironmentEvidence> {
  const state = handles.get(environment);
  if (!state || state.box.id !== environment.id) throw new Error("Tangle evidence requires a live provider environment handle");
  const sessionIds = new Set<string>([...state.sessions.entries()]
    .filter(([, executions]) => executions.has(options.executionId))
    .map(([id]) => id));
  if (options.sandboxSessionId != null) sessionIds.add(options.sandboxSessionId);
  return captureTangleSandboxEvidence(state.box, {
    executionId: options.executionId,
    harness: options.harness,
    expectedSidecarImageDigest: options.expectedSidecarImageDigest,
    requireNativeSessionCapture: options.requireNativeSessionCapture,
    sandboxSessionIds: [...sessionIds],
    sessionExecutionIds: Object.fromEntries([...sessionIds].filter((id) => state.sessions.has(id))
      .map((id) => [id, [...state.sessions.get(id)!]])),
    maxBytes: options.maxBytes,
    signal: options.signal,
  });
}

/** Export exact Sandbox session and workspace evidence before its owning box is deleted. */
export async function captureTangleSandboxEvidence(
  box: SandboxInstanceLike,
  options: TangleSandboxEvidenceOptions,
): Promise<TangleEnvironmentEvidence> {
  if (!safeIdentifier(box.id) || !safeIdentifier(options.executionId)) throw new Error("Tangle evidence requires exact box and execution ids");
  if (!safeIdentifier(options.harness)) throw new Error("Tangle evidence requires an exact profile harness");
  if (options.expectedSidecarImageDigest !== undefined &&
      !/^sha256:[0-9a-f]{64}$/.test(options.expectedSidecarImageDigest)) {
    throw new Error("Tangle evidence expected sidecar digest is invalid");
  }
  if (!Array.isArray(options.sandboxSessionIds) || options.sandboxSessionIds.some((id) => !safeIdentifier(id))) {
    throw new Error("Tangle evidence Sandbox session ids are invalid");
  }
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) throw new Error("Tangle evidence maxBytes must be positive");
  if (options.sessionExecutionIds && Object.keys(options.sessionExecutionIds).some((id) => !options.sandboxSessionIds.includes(id))) {
    throw new Error("Tangle evidence execution mapping names an unrelated Sandbox session");
  }
  const captureProof = options.requireNativeSessionCapture ? requireNativeCaptureProof(box) : null;
  const workspaceRoot = options.workspaceRoot ?? ".";
  if (workspaceRoot !== ".") canonicalEntryPath(workspaceRoot);
  const fs = box.fs;
  if (!fs?.list || !fs.usage || !fs.readBatch) throw new Error("Tangle evidence requires workspace list, usage, and binary batch read");
  options.signal?.throwIfAborted();
  const usage = await fs.usage(workspaceRoot);
  if (!usage.complete || usage.skippedEntries !== 0) throw new Error("Tangle workspace usage scan is incomplete");
  if (usage.sizeBytes > options.maxBytes) throw new Error("Tangle workspace exceeds evidence byte limit");
  const files: TangleEnvironmentEvidence["files"] = [];
  const metadata: WorkspaceEntryMetadata[] = [];
  const seenPaths = new Set<string>();
  const excludedPaths: TangleEnvironmentEvidence["provenance"]["excludedPaths"] = [];
  const stack = [workspaceRoot];
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
      const sourcePath = canonicalEntryPath(entry.path);
      if (workspaceRoot !== "." && !sourcePath.startsWith(workspaceRoot + "/")) {
        throw new Error("Tangle workspace list returned a path outside its worker directory");
      }
      const path = workspaceRoot === "." ? sourcePath : canonicalEntryPath(sourcePath.slice(workspaceRoot.length + 1));
      if (seenPaths.has(path)) throw new Error("Tangle workspace inventory repeats a path");
      seenPaths.add(path);
      const expectedParent = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : ".";
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
        stack.push(sourcePath);
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
      const result = await fs.readBatch([sourcePath], { encoding: "base64" });
      if (result.errors.length || result.files.length !== 1 || result.files[0]?.path !== sourcePath || result.files[0]?.encoding !== "base64") {
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
  const sessionIds = new Set(options.sandboxSessionIds);
  const sessions: TangleEnvironmentEvidence["provenance"]["sessions"] = [];
  const attempts: TangleEvidenceAttemptLike[] = [];
  const missing: string[] = [];
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
    const executionIds = options.sessionExecutionIds?.[id] ?? [options.executionId];
    if (!executionIds.length || new Set(executionIds).size !== executionIds.length ||
        executionIds.some((executionId) => !safeIdentifier(executionId))) {
      throw new Error("Tangle evidence has invalid session execution attribution");
    }
    const events: Array<{ executionId: string; event: unknown }> = [];
    const eventCountsByExecutionId: Record<string, number> = {};
    for (const executionId of executionIds) {
      eventCountsByExecutionId[executionId] = 0;
      for await (const event of session.events({ since: "0", executionId, signal: options.signal })) {
        options.signal?.throwIfAborted();
        if (events.length >= MAX_EVENTS) throw new Error("Tangle event replay limit exceeded");
        if (typeof event.data?.executionId === "string" && event.data.executionId !== executionId) {
          throw new Error("Tangle event replay returned an unrelated execution");
        }
        if (typeof event.data?.runtimeSessionId === "string" && event.data.runtimeSessionId !== id) {
          throw new Error("Tangle event replay returned an unrelated session");
        }
        const attributed = { executionId, event };
        capturedBytes += Buffer.byteLength(JSON.stringify(attributed));
        if (capturedBytes > options.maxBytes) throw new Error("Tangle evidence exceeds byte limit");
        events.push(attributed);
        eventCountsByExecutionId[executionId] += 1;
      }
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
    const bytes = Buffer.from(JSON.stringify({ kind: "tangle-session-transport.v1", environmentId: box.id, sessionId: id, executionIds, status, events, messages, messageScope: "session" }));
    if (files.reduce((sum, file) => sum + file.bytes.byteLength, 0) + bytes.byteLength > options.maxBytes) throw new Error("Tangle evidence exceeds byte limit");
    capturedBytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0) + bytes.byteLength;
    files.push({ path: `__retention__/sessions/${id}.json`, bytes, mode: 0o600 });
    const rawNative = await session.rawEvidence?.();
    if (rawNative !== undefined && (rawNative === null || typeof rawNative !== "object")) {
      throw new Error("Tangle raw evidence is malformed");
    }
    const native = rawNative as TangleRawEvidenceLike | undefined;
    const nativeStore: TangleEnvironmentEvidence["provenance"]["sessions"][number]["nativeStore"] = {
      scope: "session", roots: [], inventory: null, complete: false, entries: [], excludedPaths: [],
    };
    const processStreams: TangleEnvironmentEvidence["provenance"]["sessions"][number]["processStreams"] = {
      complete: false, streamCount: 0, processCount: 0, terminalCount: 0,
      stdinBytes: 0, stdoutBytes: 0, stderrBytes: 0, protocolBytes: 0, terminals: [],
    };
    const nativeEvents: TangleEnvironmentEvidence["provenance"]["sessions"][number]["nativeEvents"] = {
      scope: "execution", complete: false, count: 0,
    };
    let nativeSessionId: string | null = null;
    let sidecarImageDigest: string | null = null;
    let sidecarBundleRevision: string | null = null;
    let nativeReason: string | null = "raw-session-capture-capability-absent";
    if (native !== undefined) {
      if (native.sessionId !== id || native.backendType !== options.harness) {
        throw new Error("Tangle raw evidence returned an unrelated session or profile backend");
      }
      if (native.nativeSessionId != null && !safeIdentifier(native.nativeSessionId)) {
        throw new Error("Tangle raw evidence native session id is invalid");
      }
      nativeSessionId = native.nativeSessionId ?? null;
      if (native.status === "captured" || native.status === "partial") {
        const partial = native.status === "partial";
        if (captureProof && (native.proofStatus !== "verified" ||
            native.containerId !== captureProof.containerId ||
            native.sidecarImageDigest !== captureProof.imageId ||
            native.sidecarBundleRevision !== captureProof.bundleRevision ||
            native.sidecarBundleChecksum !== captureProof.bundleChecksum)) {
          throw new Error("Tangle raw session identity differs from verified create proof");
        }
        if (!/^sha256:[0-9a-f]{64}$/.test(native.sidecarImageDigest) ||
            (options.expectedSidecarImageDigest !== undefined &&
             native.sidecarImageDigest !== options.expectedSidecarImageDigest)) {
          throw new Error("Tangle raw session image digest is missing or differs from deployment proof");
        }
        if (!/^[0-9a-f]{40}$/.test(native.sidecarBundleRevision)) {
          throw new Error("Tangle raw session sidecar bundle revision is missing or invalid");
        }
        sidecarImageDigest = native.sidecarImageDigest;
        sidecarBundleRevision = native.sidecarBundleRevision;
        if (typeof native.completeness?.nativeStore !== "boolean" || typeof native.completeness.processIo !== "boolean" ||
            typeof native.completeness.events !== "boolean" || !Array.isArray(native.files) ||
            !Array.isArray(native.processIo) || !Array.isArray(native.events) ||
            !Array.isArray(native.excluded) || !Array.isArray(native.nativeRoots) || !native.inventory ||
            !Array.isArray(native.processTerminals) || typeof native.coverageComplete !== "boolean" ||
            !Array.isArray(native.missingReasons) || native.missingReasons.some((reason) => !safeIdentifier(reason))) {
          throw new Error("Tangle raw session capture is malformed");
        }
        if ((!partial && (native.completeness.nativeStore !== true || native.completeness.processIo !== true ||
            native.completeness.events !== true || native.coverageComplete !== true || native.missingReasons.length > 0)) ||
            (partial && native.coverageComplete !== false)) {
          throw new Error("Tangle raw session capture is incomplete");
        }
        const sessionAttempts = readNativeAttempts(native.attempts, executionIds, partial);
        const nativeEventCoverage = nativeEventsMatch(native.events, id, executionIds, partial);
        attempts.push(...sessionAttempts);
        if (partial) missing.push(`Sandbox session ${id} declared partial raw capture`);
        for (const reason of native.missingReasons) missing.push(`Sandbox session ${id}: ${reason}`);
        for (const attempt of sessionAttempts) {
          for (const reason of attempt.missingReasons) {
            missing.push(`Sandbox session ${id} attempt ${attempt.executionId}/${attempt.ordinal}: ${reason}`);
          }
        }
        if (!sessionAttempts.length) missing.push(`Sandbox session ${id} has no attempt inventory`);
        const nativeIds = new Set(sessionAttempts.flatMap((attempt) => attempt.nativeSessionIds));
        if (nativeSessionId !== null && !nativeIds.has(nativeSessionId)) {
          throw new Error("Tangle raw session identity differs from its attempt inventory");
        }
        if (native.files.length + native.processIo.length + native.processTerminals.length +
            native.events.length > MAX_ENTRIES) {
          throw new Error("Tangle raw session capture exceeds entry limit");
        }
        const roots = new Set<string>();
        for (const root of native.nativeRoots) {
          if (!["session-home", "workspace-session"].includes(root.rootScope) || roots.has(root.rootScope) ||
              !canonicalNativeRoot(root.path)) {
            throw new Error("Tangle raw session native root is invalid");
          }
          roots.add(root.rootScope);
          nativeStore.roots.push({ scope: root.rootScope, path: root.path });
        }
        if (!roots.size && (!partial || native.completeness.nativeStore)) throw new Error("Tangle raw session has no native root");
        const nativePaths = new Set<string>();
        const included = { file: 0, directory: 0, symlink: 0 };
        const excluded = { file: 0, directory: 0, symlink: 0 };
        for (const entry of native.files) {
          options.signal?.throwIfAborted();
          const path = canonicalEntryPath(entry.path);
          if (!roots.has(entry.rootScope)) throw new Error("Tangle raw session entry has no native root");
          const identity = entry.rootScope + "/" + path;
          if (nativePaths.has(identity)) throw new Error("Tangle raw session repeats a native path");
          nativePaths.add(identity);
          if (!nativeStatMetadata(entry)) throw new Error("Tangle raw session entry metadata is invalid");
          if (entry.kind === "file") {
            const content = exactNativeBytes(entry.contentBase64, entry.sizeBytes, entry.sha256,
              options.maxBytes - capturedBytes);
            if (capturedBytes + content.byteLength > options.maxBytes) throw new Error("Tangle evidence exceeds byte limit");
            files.push({ path: "__retention__/sessions/" + id + "/native/" + entry.rootScope + "/" + path, bytes: content, mode: entry.mode & 0o777 });
            capturedBytes += content.byteLength;
          } else if (entry.kind === "directory" || entry.kind === "symlink") {
            if (entry.contentBase64 !== undefined || entry.sha256 !== undefined ||
                (entry.kind === "symlink" && (typeof entry.linkTarget !== "string" || entry.linkTarget.includes("\0")))) {
              throw new Error("Tangle raw session non-file entry is malformed");
            }
          } else {
            throw new Error("Tangle raw session entry kind is invalid");
          }
          included[entry.kind] += 1;
          nativeStore.entries.push({
            rootScope: entry.rootScope, path, kind: entry.kind, mode: entry.mode,
            uid: entry.uid, gid: entry.gid, mtimeMs: entry.mtimeMs, ctimeMs: entry.ctimeMs,
            sizeBytes: entry.sizeBytes, sha256: entry.sha256 ?? null, linkTarget: entry.linkTarget ?? null,
          });
        }
        for (const exclusion of native.excluded) {
          const path = canonicalEntryPath(exclusion.path);
          const identity = exclusion.rootScope + "/" + path;
          if (!roots.has(exclusion.rootScope) || nativePaths.has(identity) ||
              exclusion.reason !== "credential" || !["file", "directory", "symlink"].includes(exclusion.kind) ||
              !nativeStatMetadata(exclusion)) {
            throw new Error("Tangle raw session exclusion is invalid");
          }
          nativePaths.add(identity);
          excluded[exclusion.kind] += 1;
          nativeStore.excludedPaths.push({
            rootScope: exclusion.rootScope, path, kind: exclusion.kind, mode: exclusion.mode,
            uid: exclusion.uid, gid: exclusion.gid, mtimeMs: exclusion.mtimeMs, ctimeMs: exclusion.ctimeMs,
            sizeBytes: exclusion.sizeBytes, reason: exclusion.reason,
          });
        }
        const inventory = native.inventory;
        const counts = [
          inventory.reportedFiles, inventory.scannedFiles, inventory.excludedFiles,
          inventory.reportedDirectories, inventory.scannedDirectories, inventory.excludedDirectories,
          inventory.reportedSymlinks, inventory.scannedSymlinks, inventory.excludedSymlinks,
        ];
        if (counts.some((value) => !Number.isSafeInteger(value) || value < 0) ||
            !Number.isSafeInteger(inventory.skippedEntries) || inventory.skippedEntries < 0 ||
            (!partial && inventory.skippedEntries !== 0) ||
            inventory.reportedFiles !== included.file ||
            inventory.reportedDirectories !== included.directory ||
            inventory.reportedSymlinks !== included.symlink ||
            inventory.excludedFiles !== excluded.file ||
            inventory.excludedDirectories !== excluded.directory ||
            inventory.excludedSymlinks !== excluded.symlink ||
            inventory.scannedFiles < inventory.reportedFiles + inventory.excludedFiles ||
            inventory.scannedDirectories < inventory.reportedDirectories + inventory.excludedDirectories ||
            inventory.scannedSymlinks < inventory.reportedSymlinks + inventory.excludedSymlinks ||
            (!partial && (inventory.scannedFiles !== inventory.reportedFiles + inventory.excludedFiles ||
              inventory.scannedDirectories !== inventory.reportedDirectories + inventory.excludedDirectories ||
              inventory.scannedSymlinks !== inventory.reportedSymlinks + inventory.excludedSymlinks))) {
          throw new Error("Tangle raw session inventory does not reconcile");
        }
        nativeStore.inventory = {
          scannedFiles: inventory.scannedFiles,
          reportedFiles: inventory.reportedFiles,
          excludedFiles: inventory.excludedFiles,
          scannedDirectories: inventory.scannedDirectories,
          reportedDirectories: inventory.reportedDirectories,
          excludedDirectories: inventory.excludedDirectories,
          scannedSymlinks: inventory.scannedSymlinks,
          reportedSymlinks: inventory.reportedSymlinks,
          excludedSymlinks: inventory.excludedSymlinks,
          skippedEntries: inventory.skippedEntries,
        };
        const ioSequences = new Map<string, Set<number>>();
        const frameMetadata: Array<Record<string, unknown>> = [];
        for (const frame of native.processIo) {
          options.signal?.throwIfAborted();
          if (!safeIdentifier(frame.processId) || !Number.isSafeInteger(frame.sequence) ||
              frame.sequence < 0 || !Number.isFinite(Date.parse(frame.at)) ||
              !["stdin", "stdout", "stderr", "protocol"].includes(frame.stream)) {
            throw new Error("Tangle raw session process stream metadata is invalid");
          }
          const sequences = ioSequences.get(frame.processId) ?? new Set<number>();
          if (sequences.has(frame.sequence)) throw new Error("Tangle raw session repeats a process frame");
          sequences.add(frame.sequence);
          ioSequences.set(frame.processId, sequences);
          if (!processAttemptMatches(frame, sessionAttempts, partial)) {
            missing.push(`Sandbox session ${id} process ${frame.processId} has no exact attempt attribution`);
          }
          const content = exactNativeBytes(frame.contentBase64, frame.sizeBytes, frame.sha256,
            options.maxBytes - capturedBytes);
          if (capturedBytes + content.byteLength > options.maxBytes) throw new Error("Tangle evidence exceeds byte limit");
          const label = String(frame.sequence).padStart(16, "0");
          files.push({ path: "__retention__/sessions/" + id + "/io/" + frame.processId + "/" + label +
            "-" + frame.stream + ".bin", bytes: content, mode: 0o600 });
          frameMetadata.push({
            processId: frame.processId, sequence: frame.sequence, at: frame.at, stream: frame.stream,
            executionId: frame.executionId ?? null, ordinal: frame.ordinal ?? null, providerSessionId: frame.providerSessionId ?? null,
            sizeBytes: frame.sizeBytes, sha256: frame.sha256,
            ...(frame.metadata === undefined ? {} : { metadata: frame.metadata }),
          });
          capturedBytes += content.byteLength;
          const counter = (frame.stream + "Bytes") as "stdinBytes" | "stdoutBytes" | "stderrBytes" | "protocolBytes";
          processStreams[counter] += content.byteLength;
          processStreams.streamCount += 1;
        }
        const terminals = new Set<string>();
        for (const terminal of native.processTerminals) {
          if (!safeIdentifier(terminal.processId) || terminals.has(terminal.processId) ||
              !Number.isSafeInteger(terminal.sequence) || terminal.sequence < 0 ||
              !Number.isFinite(Date.parse(terminal.at)) ||
              !(terminal.result?.captureError === null || (partial && typeof terminal.result?.captureError === "string")) ||
              !(terminal.result.code === null || Number.isSafeInteger(terminal.result.code)) ||
              !(terminal.result.signal === null || typeof terminal.result.signal === "string") ||
              typeof terminal.result.timedOut !== "boolean" ||
              !(terminal.result.timeoutReason === null || typeof terminal.result.timeoutReason === "string") ||
              (terminal.result.spawnError !== undefined && typeof terminal.result.spawnError !== "string")) {
            throw new Error("Tangle raw session process terminal metadata is invalid");
          }
          const sequences = ioSequences.get(terminal.processId) ?? new Set<number>();
          if (!processAttemptMatches(terminal, sessionAttempts, partial)) {
            missing.push(`Sandbox session ${id} terminal ${terminal.processId} has no exact attempt attribution`);
          }
          if (!partial && (terminal.sequence !== sequences.size ||
              [...sequences].some((sequence) => sequence < 0 || sequence >= terminal.sequence))) {
            throw new Error("Tangle raw session process sequence is incomplete");
          }
          terminals.add(terminal.processId);
          processStreams.terminals.push(terminal);
        }
        if (!partial && [...ioSequences.keys()].some((processId) => !terminals.has(processId))) {
          throw new Error("Tangle raw session has a process without a terminal receipt");
        }
        const observedProcessIds = new Set([...ioSequences.keys(), ...terminals]);
        if (sessionAttempts.some((attempt) => attempt.processIds.some((processId) => !observedProcessIds.has(processId)))) {
          if (!partial) throw new Error("Tangle raw session attempt names an unretained process");
          missing.push(`Sandbox session ${id} attempt inventory names an unretained process`);
        }
        if (!partial && [...observedProcessIds].some((processId) =>
            !sessionAttempts.some((attempt) => attempt.processIds.includes(processId)))) {
          throw new Error("Tangle raw session process has no attempt attribution");
        }
        processStreams.processCount = observedProcessIds.size;
        processStreams.terminalCount = terminals.size;
        if (native.processSource !== undefined) {
          const source = exactNativeBytes(native.processSource.contentBase64, native.processSource.sizeBytes,
            native.processSource.sha256, options.maxBytes - capturedBytes);
          const sourcePath = "__retention__/sessions/" + id + "/process-source.jsonl";
          files.push({ path: sourcePath, bytes: source, mode: 0o600 });
          capturedBytes += source.byteLength;
          processStreams.source = { path: sourcePath, sizeBytes: source.byteLength, sha256: native.processSource.sha256 };
        }
        const processManifest = Buffer.from(JSON.stringify({
          kind: "tangle-native-process-streams.v1", sessionId: id,
          frames: frameMetadata, terminals: native.processTerminals,
          ...(processStreams.source ? { source: processStreams.source } : {}),
        }));
        if (capturedBytes + processManifest.byteLength > options.maxBytes) throw new Error("Tangle evidence exceeds byte limit");
        files.push({ path: "__retention__/sessions/" + id + "/process-manifest.json",
          bytes: processManifest, mode: 0o600 });
        capturedBytes += processManifest.byteLength;
        const nativeEventBytes = Buffer.from(JSON.stringify({
          kind: "tangle-native-session-events.v1", sessionId: id, backendType: native.backendType,
          nativeSessionId, scope: "execution", events: native.events,
        }));
        if (capturedBytes + nativeEventBytes.byteLength > options.maxBytes) throw new Error("Tangle evidence exceeds byte limit");
        files.push({ path: "__retention__/sessions/" + id + "/native-events.json", bytes: nativeEventBytes, mode: 0o600 });
        capturedBytes += nativeEventBytes.byteLength;
        nativeStore.complete = native.completeness.nativeStore && inventory.skippedEntries === 0 &&
          inventory.scannedFiles === inventory.reportedFiles + inventory.excludedFiles &&
          inventory.scannedDirectories === inventory.reportedDirectories + inventory.excludedDirectories &&
          inventory.scannedSymlinks === inventory.reportedSymlinks + inventory.excludedSymlinks;
        processStreams.complete = native.completeness.processIo && [...ioSequences.keys()].every((processId) => terminals.has(processId)) &&
          native.processTerminals.every((terminal) => {
            const sequences = ioSequences.get(terminal.processId) ?? new Set<number>();
            return terminal.result.captureError === null && terminal.sequence === sequences.size &&
              [...sequences].every((sequence) => sequence >= 0 && sequence < terminal.sequence);
          });
        nativeEvents.complete = native.completeness.events && nativeEventCoverage;
        nativeEvents.count = native.events.length;
        nativeReason = partial ? (native.missingReasons.join("; ") || "partial-capture") : null;
      } else if (native.status === "unavailable") {
        if (!safeIdentifier(native.reason)) throw new Error("Tangle raw session unavailability reason is invalid");
        nativeReason = native.reason;
      } else {
        throw new Error("Tangle raw session capture status is invalid");
      }
    }
    sessions.push({
      id, executionId: options.executionId, executionIds: [...executionIds], eventCountsByExecutionId,
      backendType: options.harness, sidecarImageDigest, sidecarBundleRevision,
      transportEvents: executionIds.every((executionId) => eventCountsByExecutionId[executionId] > 0) ? "complete" : "unavailable",
      eventCount: events.length, messageCount: messages.length, messageScope: "session",
      nativeSessionId, nativeReason, nativeStore, processStreams, nativeEvents,
    });
    for (const executionId of executionIds) {
      if (!eventCountsByExecutionId[executionId]) {
        missing.push("Sandbox session " + id + " returned no events for execution " + executionId);
      }
    }
    if (!nativeStore.complete || !processStreams.complete || !nativeEvents.complete) {
      missing.push("Raw native session capture for Sandbox session " + id + " is unavailable: " + nativeReason);
    }
  }
  const provenance: TangleEnvironmentEvidence["provenance"] = {
    provider: "tangle-sandbox",
    environmentId: box.id,
    executionId: options.executionId,
    ...(captureProof ? { captureProof } : {}),
    workspaceScope: "environment",
    workspaceRoot,
    capturedAt: new Date().toISOString(),
    entries: metadata.sort((a, b) => a.path.localeCompare(b.path)),
    excludedPaths,
    workspace: { scannedFiles, scannedDirectories, reportedFiles: usage.fileCount, reportedDirectories: usage.directoryCount, complete: true },
    attempts,
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

/** Source roots are metadata; archive entry paths remain relative. */
function canonicalNativeRoot(value: string): boolean {
  if (typeof value !== "string" || value.includes("\\") || value.includes("\0")) return false;
  if (value === ".") return true;
  const parts = (value.startsWith("/") ? value.slice(1) : value).split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function readNativeAttempts(value: unknown, executionIds: readonly string[], partial: boolean): TangleEvidenceAttemptLike[] {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES || (!partial && value.length === 0)) {
    throw new Error("Tangle raw session attempt inventory is missing or invalid");
  }
  const ordinals = new Map<string, Set<number>>();
  const attempts: TangleEvidenceAttemptLike[] = [];
  for (const entry of value) {
    if (!isEvidenceAttempt(entry) || !executionIds.includes(entry.executionId)) {
      throw new Error("Tangle raw session attempt has invalid identity or an unrelated execution");
    }
    const seen = ordinals.get(entry.executionId) ?? new Set<number>();
    if (seen.has(entry.ordinal)) throw new Error("Tangle raw session repeats an attempt ordinal");
    seen.add(entry.ordinal);
    ordinals.set(entry.executionId, seen);
    if (!partial && (!entry.nativeSessionIds.length ||
        entry.outcome === "unknown" || entry.missingReasons.length > 0)) {
      throw new Error("Tangle raw session attempt coverage is incomplete");
    }
    attempts.push({ ...entry, nativeSessionIds: [...entry.nativeSessionIds], processIds: [...entry.processIds], missingReasons: [...entry.missingReasons] });
  }
  if (!partial && executionIds.some((id) => {
    const seen = ordinals.get(id);
    return !seen || Array.from({ length: seen.size }, (_, i) => i + 1).some((ordinal) => !seen.has(ordinal));
  })) {
    throw new Error("Tangle raw session attempt inventory does not cover every execution and retry");
  }
  return attempts;
}

function isEvidenceAttempt(value: unknown): value is TangleEvidenceAttemptLike {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  const identifiers = (candidate: unknown): candidate is string[] => Array.isArray(candidate) &&
    candidate.every((id: unknown) => typeof id === "string" && safeIdentifier(id)) && new Set(candidate).size === candidate.length;
  return typeof entry.executionId === "string" && safeIdentifier(entry.executionId) &&
    Number.isSafeInteger(entry.ordinal) && Number(entry.ordinal) > 0 &&
    typeof entry.providerSessionId === "string" && safeIdentifier(entry.providerSessionId) &&
    identifiers(entry.nativeSessionIds) && identifiers(entry.processIds) &&
    typeof entry.outcome === "string" && ["succeeded", "failed", "cancelled", "unknown"].includes(entry.outcome) &&
    identifiers(entry.missingReasons);
}

function processAttemptMatches(
  value: { processId: string; executionId?: string; ordinal?: number; providerSessionId?: string },
  attempts: readonly TangleEvidenceAttemptLike[],
  partial: boolean,
): boolean {
  const owners = attempts.filter((attempt) => attempt.processIds.includes(value.processId));
  const exact = owners.length === 1 && owners[0]?.executionId === value.executionId &&
    owners[0]?.ordinal === value.ordinal && owners[0]?.providerSessionId === value.providerSessionId;
  if (!exact && !partial) throw new Error("Tangle raw session process has missing or conflicting attempt attribution");
  return exact;
}

function nativeEventsMatch(events: readonly unknown[], sessionId: string, executionIds: readonly string[], partial: boolean): boolean {
  const seen = new Set<string>();
  let countsComplete = true;
  for (const event of events) {
    if (event === null || typeof event !== "object") throw new Error("Tangle raw session event buffer is malformed");
    const entry = event as Record<string, unknown>;
    if (entry.metadata === null || typeof entry.metadata !== "object" || !Array.isArray(entry.frames)) {
      throw new Error("Tangle raw session event buffer is malformed");
    }
    const metadata = entry.metadata as Record<string, unknown>;
    if (metadata.sessionId !== sessionId || typeof metadata.executionId !== "string" ||
        !executionIds.includes(metadata.executionId) || seen.has(metadata.executionId)) {
      throw new Error("Tangle raw session event buffer has unrelated or duplicate execution identity");
    }
    if (!Number.isSafeInteger(metadata.eventCount) || Number(metadata.eventCount) < 0 || metadata.eventCount !== entry.frames.length) {
      if (!partial) throw new Error("Tangle raw session event buffer count is inconsistent");
      countsComplete = false;
    }
    seen.add(metadata.executionId);
  }
  const complete = countsComplete && executionIds.every((executionId) => seen.has(executionId));
  if (!complete && !partial) throw new Error("Tangle raw session event buffers do not cover every execution");
  return complete;
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

function exactNativeBytes(contentBase64: string | undefined, sizeBytes: number, sha256: string | undefined,
  remainingBytes: number): Uint8Array {
  if (typeof contentBase64 !== "string" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 ||
      sizeBytes > remainingBytes || contentBase64.length !== Math.ceil(sizeBytes / 3) * 4 ||
      !/^sha256:[0-9a-f]{64}$/.test(sha256 ?? "")) {
    throw new Error("Tangle raw session bytes have invalid metadata");
  }
  const bytes = Buffer.from(contentBase64, "base64");
  const digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== sizeBytes || bytes.toString("base64") !== contentBase64 || digest !== sha256) {
    throw new Error("Tangle raw session bytes do not match the server receipt");
  }
  return bytes;
}


function nativeStatMetadata(entry: {
  mode: number; uid: number; gid: number; mtimeMs: number; ctimeMs: number; sizeBytes: number;
}): boolean {
  return Number.isSafeInteger(entry.mode) && entry.mode >= 0 &&
    Number.isSafeInteger(entry.uid) && entry.uid >= 0 &&
    Number.isSafeInteger(entry.gid) && entry.gid >= 0 &&
    Number.isFinite(entry.mtimeMs) && entry.mtimeMs >= 0 &&
    Number.isFinite(entry.ctimeMs) && entry.ctimeMs >= 0 &&
    Number.isSafeInteger(entry.sizeBytes) && entry.sizeBytes >= 0;
}

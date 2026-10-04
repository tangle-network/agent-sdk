import { createHash } from "node:crypto";
import { EvidenceJsonArray, evidenceJsonChunks } from "./tangle-evidence-json.js";
import { createDirectoryEvidenceWriter, createMemoryEvidenceWriter, type EvidenceWriter } from "./tangle-evidence-writer.js";
import { prepareNativeDirectoryEvidence, nativePayloadChunks, type RetainedNativeEvidence } from "./tangle-evidence-native-files.js";
import { AgentExactRunControlRefSchema, type AgentExactRunControlRef, type AgentProfile } from "@tangle-network/agent-interface";
import type { AgentEnvironment } from "@tangle-network/agent-interface/environment-provider";
import type { NativeCaptureProofLike, SandboxInstanceLike, TangleEvidenceAttemptLike, TangleEvidenceSourceLike } from "./tangle-types.js";
import { requireNativeCaptureProof } from "./tangle-native-capture-proof.js";
import { retainedCaptureAttribution } from "./tangle-retained-attribution.js";

const handles = new WeakMap<AgentEnvironment, { box: SandboxInstanceLike; sessions: Map<string, Set<string>> }>();
const blockedNames = new Set([".ssh", ".config", ".claude", ".codex", ".opencode", ".env", ".env.local", ".npmrc", ".sidecar"]);
const MAX_ENTRIES = 100_000;
const MAX_EVENTS = 100_000;
// Match the Sidecar request limit without accumulating 100 large JSON payloads.
const WORKSPACE_BATCH_FILES = 100;
const WORKSPACE_BATCH_BYTES = 8 * 1024 * 1024;
interface WorkspaceFileRead {
  sourcePath: string;
  path: string;
  size: number;
  mode: number;
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
  /** Runtime artifact identity when controlRef is supplied; otherwise the native execution id. */
  executionId: string;
  /** Durable admitted coordinates, including when a reconstructed environment has no session cache. */
  controlRef?: AgentExactRunControlRef;
  harness: NonNullable<AgentProfile["harness"]>;
  /** Optional local image ID to compare with the running sidecar image. */
  expectedSidecarImageDigest?: string;
  /** Require raw session bytes to match this box's current verified create proof. */
  requireNativeSessionCapture?: boolean;
  /** Exact Sandbox session id when execution was reattached after provider restart. */
  sandboxSessionId?: string | null;
  /**
   * `none` exports the attributed sessions' native evidence without walking the workspace. A
   * caller uses it to copy a harness session while its turn is still running, or when the
   * workspace is over the byte bound, so neither the workspace's size nor its scan can lose the
   * session. Defaults to `environment`, which captures both.
   */
  workspace?: "environment" | "none";
  maxBytes: number;
  signal?: AbortSignal;
}

export interface TangleSandboxEvidenceOptions extends Omit<TangleEnvironmentEvidenceOptions, "sandboxSessionId"> {
  /** Runtime artifact identity; native executionId remains subject to path-safe validation. */
  runtimeExecutionId?: string;
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
    controlRef?: AgentExactRunControlRef;
    captureProof?: NativeCaptureProofLike;
    workspaceScope: "environment" | "none";
    workspaceRoot: string;
    capturedAt: string;
    entries: WorkspaceEntryMetadata[];
    excludedPaths: Array<WorkspaceEntryMetadata & { reason: "credential-path" | "symlink" | "runtime-owned" }>;
    /** `complete` is false only when `workspaceScope` is `none`: no workspace was scanned. */
    workspace: { scannedFiles: number; scannedDirectories: number; reportedFiles: number; reportedDirectories: number; complete: boolean };
    attempts: TangleEvidenceAttemptLike[];
    sessions: Array<{
      id: string;
      executionId: string;
      executionIds: string[];
      /** Original admitted references recovered from retained server frames. */
      controlRefs?: AgentExactRunControlRef[];
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
      evidenceSources: TangleEvidenceSourceLike[];
      nativeStore: {
        scope: "session";
        roots: Array<{ scope: "session-home" | "workspace-session"; path: string; sourceId?: string }>;
        inventory: {
          scannedFiles: number; reportedFiles: number; excludedFiles: number;
          scannedDirectories: number; reportedDirectories: number; excludedDirectories: number;
          scannedSymlinks: number; reportedSymlinks: number; excludedSymlinks: number;
          skippedEntries: number;
        } | null;
        complete: boolean;
        entries: Array<{
          sourceId?: string;
          rootScope: "session-home" | "workspace-session"; path: string; kind: "file" | "directory" | "symlink";
          mode: number; uid: number; gid: number; mtimeMs: number; ctimeMs: number; sizeBytes: number;
          sha256: string | null; linkTarget: string | null;
        }>;
        excludedPaths: Array<{
          sourceId?: string;
          rootScope: "session-home" | "workspace-session"; path: string; kind: "file" | "directory" | "symlink";
          mode: number; uid: number; gid: number; mtimeMs: number; ctimeMs: number; sizeBytes: number;
          reason: "credential";
        }>;
      };
      processStreams: {
        complete: boolean; streamCount: number; processCount: number; terminalCount: number;
        stdinBytes: number; stdoutBytes: number; stderrBytes: number; protocolBytes: number;
        sources: Array<{ sourceId: string; path: string; sizeBytes: number; sha256: string }>;
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
  const context = evidenceContext(environment, options);
  return captureTangleSandboxEvidence(context.box, context.options);
}

export interface TangleDirectoryEvidence {
  directory: string;
  provenance: TangleEnvironmentEvidence["provenance"];
}

/** Capture to a new private directory without accumulating workspace content in memory. */
export async function captureTangleEnvironmentEvidenceToDirectory(
  environment: AgentEnvironment,
  options: TangleEnvironmentEvidenceOptions & { destination: string },
): Promise<TangleDirectoryEvidence> {
  const context = evidenceContext(environment, options);
  return captureTangleSandboxEvidenceToDirectory(context.box, { ...context.options, destination: options.destination });
}

/** The caller owns a successful directory; incomplete captures are removed. */
export async function captureTangleSandboxEvidenceToDirectory(
  box: SandboxInstanceLike,
  options: TangleSandboxEvidenceOptions & { destination: string },
): Promise<TangleDirectoryEvidence> {
  const writer = await createDirectoryEvidenceWriter(options.destination, options.maxBytes, options.signal);
  try {
    const provenance = await captureSandboxEvidence(box, options, writer);
    return { directory: writer.directory, provenance };
  } catch (error) {
    await writer.remove();
    throw error;
  }
}

function evidenceContext(environment: AgentEnvironment, options: TangleEnvironmentEvidenceOptions): {
  box: SandboxInstanceLike; options: TangleSandboxEvidenceOptions;
} {
  const state = handles.get(environment);
  if (!state || state.box.id !== environment.id) throw new Error("Tangle evidence requires a live provider environment handle");
  const controlRef = options.controlRef === undefined ? undefined : AgentExactRunControlRefSchema.parse(options.controlRef);
  if (controlRef && (controlRef.environmentId !== environment.id || controlRef.provider !== environment.provider ||
      (options.sandboxSessionId != null && options.sandboxSessionId !== controlRef.sessionId))) {
    throw new Error("Tangle evidence control reference names another environment or session");
  }
  const executionId = controlRef?.executionId ?? options.executionId;
  const sessionIds = controlRef ? new Set([controlRef.sessionId]) : new Set<string>([...state.sessions.entries()]
    .filter(([, executions]) => executions.has(executionId))
    .map(([id]) => id));
  if (options.sandboxSessionId != null) sessionIds.add(options.sandboxSessionId);
  const sessionExecutionIds = Object.fromEntries([...sessionIds].filter((id) => state.sessions.has(id))
    .map((id) => [id, [...state.sessions.get(id)!]]));
  if (controlRef) sessionExecutionIds[controlRef.sessionId] = [...new Set([
    ...(sessionExecutionIds[controlRef.sessionId] ?? []), controlRef.executionId,
  ])];
  return { box: state.box, options: {
    executionId,
    ...(controlRef === undefined ? {} : { runtimeExecutionId: options.executionId, controlRef }),
    harness: options.harness,
    expectedSidecarImageDigest: options.expectedSidecarImageDigest,
    requireNativeSessionCapture: options.requireNativeSessionCapture,
    sandboxSessionIds: [...sessionIds],
    sessionExecutionIds,
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    maxBytes: options.maxBytes,
    signal: options.signal,
  } };
}

/** Export exact Sandbox session and workspace evidence before its owning box is deleted. */
export async function captureTangleSandboxEvidence(
  box: SandboxInstanceLike,
  options: TangleSandboxEvidenceOptions,
): Promise<TangleEnvironmentEvidence> {
  const writer = createMemoryEvidenceWriter(options.maxBytes, options.signal);
  const provenance = await captureSandboxEvidence(box, options, writer);
  return { files: writer.files.sort((a, b) => a.path.localeCompare(b.path)), provenance };
}

async function captureSandboxEvidence(
  box: SandboxInstanceLike,
  options: TangleSandboxEvidenceOptions,
  writer: EvidenceWriter,
): Promise<TangleEnvironmentEvidence["provenance"]> {
  if (!safeIdentifier(box.id) || !safeIdentifier(options.executionId)) throw new Error("Tangle evidence requires exact box and execution ids");
  const controlRef = options.controlRef === undefined ? undefined : AgentExactRunControlRefSchema.parse(options.controlRef);
  if (controlRef && (controlRef.environmentId !== box.id ||
      controlRef.executionId !== options.executionId || !options.sandboxSessionIds?.includes(controlRef.sessionId))) {
    throw new Error("Tangle evidence control reference does not bind the exact native capture");
  }
  if (options.runtimeExecutionId !== undefined && (!controlRef || typeof options.runtimeExecutionId !== "string" ||
      !options.runtimeExecutionId.length || options.runtimeExecutionId.length > 2048 || /[\u0000-\u001f\u007f]/.test(options.runtimeExecutionId))) {
    throw new Error("Tangle evidence Runtime artifact identity requires an exact admitted control reference");
  }
  const artifactExecutionId = options.runtimeExecutionId ?? options.executionId;
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
  const workspaceScope = options.workspace ?? "environment";
  if (workspaceScope !== "environment" && workspaceScope !== "none") throw new Error("Tangle evidence workspace scope is invalid");
  const boxFs = box.fs;
  if (workspaceScope === "environment" && (!boxFs?.list || !boxFs.usage || !boxFs.readBatch)) {
    throw new Error("Tangle evidence requires workspace list, usage, and binary batch read");
  }
  // Only the environment scope reads through it, after the check above.
  const fs = boxFs as NonNullable<SandboxInstanceLike["fs"]> &
    Required<Pick<NonNullable<SandboxInstanceLike["fs"]>, "list" | "usage" | "readBatch">>;
  options.signal?.throwIfAborted();
  const usage = workspaceScope === "none"
    ? { complete: true, skippedEntries: 0, sizeBytes: 0, fileCount: 0, directoryCount: 0 }
    : await fs.usage(workspaceRoot);
  if (!usage.complete || usage.skippedEntries !== 0) throw new Error("Tangle workspace usage scan is incomplete");
  if (usage.sizeBytes > options.maxBytes) throw new Error("Tangle workspace exceeds evidence byte limit");
  const metadata: WorkspaceEntryMetadata[] = [];
  const seenPaths = new Set<string>();
  const excludedPaths: TangleEnvironmentEvidence["provenance"]["excludedPaths"] = [];
  const stack = workspaceScope === "none" ? [] : [workspaceRoot];
  let scannedFiles = 0;
  let scannedDirectories = 0;
  let scannedEntries = 0;
  let scannedSize = 0;
  let capturedBytes = 0;
  let pending: WorkspaceFileRead[] = [];
  let pendingBytes = 0;
  const flushWorkspaceFiles = async () => {
    if (!pending.length) return;
    if (writer.download && pending.length === 1 && pending[0]!.size > WORKSPACE_BATCH_BYTES) {
      const entry = pending[0]!;
      await writer.download(fs, entry);
      capturedBytes += entry.size;
    } else {
      const captured = await readWorkspaceEvidenceBatch(fs, pending, options.maxBytes - capturedBytes, options.signal);
      for (const file of captured) {
        await writer.write(file);
        capturedBytes += file.bytes.byteLength;
      }
    }
    pending = [];
    pendingBytes = 0;
  };
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
      if (pending.length && (pending.length >= WORKSPACE_BATCH_FILES || pendingBytes + entry.size > WORKSPACE_BATCH_BYTES)) {
        await flushWorkspaceFiles();
      }
      if (entry.size > options.maxBytes - capturedBytes - pendingBytes) throw new Error("Tangle evidence exceeds byte limit");
      pending.push({ sourcePath, path, size: entry.size, mode: entry.permissions & 0o777 });
      pendingBytes += entry.size;
    }
  }
  if (scannedFiles !== usage.fileCount || scannedDirectories !== usage.directoryCount || scannedSize !== usage.sizeBytes) {
    throw new Error("Tangle workspace inventory does not match the complete usage scan");
  }
  await flushWorkspaceFiles();
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
    const prepared = writer.directory === undefined ? undefined :
      await prepareNativeDirectoryEvidence(session, options.maxBytes - capturedBytes, options.signal);
    try {
    const rawNative = prepared ? prepared.native : await session.rawEvidence?.();
    if (rawNative !== undefined && (rawNative === null || typeof rawNative !== "object")) {
      throw new Error("Tangle raw evidence is malformed");
    }
    const native = rawNative as RetainedNativeEvidence | undefined;
    const retainNativeContent = async (
      entry: { sizeBytes: number; sha256?: string; contentBase64?: string }, path: string, mode: number,
    ): Promise<number> => {
      const ref = prepared?.payloads.get(entry);
      if (prepared) {
        if (!ref || !prepared.directory || ref.sizeBytes !== entry.sizeBytes || ref.sha256 !== entry.sha256 ||
            ref.sizeBytes > options.maxBytes - writer.byteLength) throw new Error("Tangle native payload reference is absent or inconsistent");
        return writer.writeChunks(path, mode, nativePayloadChunks(prepared.directory, ref, options.signal));
      }
      const bytes = exactNativeBytes(entry.contentBase64, entry.sizeBytes, entry.sha256, options.maxBytes - writer.byteLength);
      await writer.write({ path, bytes, mode });
      return bytes.byteLength;
    };
    const nativeStore: TangleEnvironmentEvidence["provenance"]["sessions"][number]["nativeStore"] = {
      scope: "session", roots: [], inventory: null, complete: false, entries: [], excludedPaths: [],
    };
    const processStreams: TangleEnvironmentEvidence["provenance"]["sessions"][number]["processStreams"] = {
      complete: false, streamCount: 0, processCount: 0, terminalCount: 0,
      stdinBytes: 0, stdoutBytes: 0, stderrBytes: 0, protocolBytes: 0, terminals: [],
      sources: [],
    };
    const nativeEvents: TangleEnvironmentEvidence["provenance"]["sessions"][number]["nativeEvents"] = {
      scope: "execution", complete: false, count: 0,
    };
    const executionIds = [...(options.sessionExecutionIds?.[id] ?? [options.executionId])];
    if (!executionIds.length || new Set(executionIds).size !== executionIds.length ||
        executionIds.some((executionId) => !safeIdentifier(executionId))) {
      throw new Error("Tangle evidence has invalid session execution attribution");
    }
    let recoveredControlRefs: AgentExactRunControlRef[] = [];
    let admissionMissing: string[] = [];
    if (controlRef && native && (native.status === "captured" || native.status === "partial") &&
        Array.isArray(native.attempts) && Array.isArray(native.events) &&
        native.attempts.some(attempt => isEvidenceAttempt(attempt) && !executionIds.includes(attempt.executionId))) {
      const recovered = await retainedCaptureAttribution(native.events, controlRef, options.signal);
      recoveredControlRefs = recovered.controlRefs;
      admissionMissing = recovered.missing;
      for (const ref of recoveredControlRefs) {
        if (!executionIds.includes(ref.executionId)) executionIds.push(ref.executionId);
      }
      missing.push(...admissionMissing);
    }
    const counts = { events: 0, messages: 0 };
    const eventCountsByExecutionId: Record<string, number> = {};
    const events = new EvidenceJsonArray(undefined, async function* () {
      for (const executionId of executionIds) {
        eventCountsByExecutionId[executionId] = 0;
        for await (const event of session.events!({ since: "0", executionId, signal: options.signal })) {
          options.signal?.throwIfAborted();
          if (counts.events >= MAX_EVENTS) throw new Error("Tangle event replay limit exceeded");
          if (typeof event.data?.executionId === "string" && event.data.executionId !== executionId) {
            throw new Error("Tangle event replay returned an unrelated execution");
          }
          if (typeof event.data?.runtimeSessionId === "string" && event.data.runtimeSessionId !== id) {
            throw new Error("Tangle event replay returned an unrelated session");
          }
          counts.events++;
          eventCountsByExecutionId[executionId] += 1;
          yield { executionId, event };
        }
      }
    });
    const messages = new EvidenceJsonArray(undefined, async function* () {
      const pageSize = 100;
      for (let offset = 0; ; offset += pageSize) {
        options.signal?.throwIfAborted();
        if (offset >= MAX_EVENTS) throw new Error("Tangle message pagination limit exceeded");
        const page = await session.messages!({ limit: pageSize, offset });
        if (!Array.isArray(page) || page.length > pageSize) throw new Error("Tangle session message page is malformed");
        for (const message of page) { counts.messages++; yield message; }
        if (page.length < pageSize) break;
      }
    });
    await writer.writeChunks(`__retention__/sessions/${id}.json`, 0o600,
      evidenceJsonChunks({ kind: "tangle-session-transport.v1", environmentId: box.id, sessionId: id,
        executionIds, status, events, messages, messageScope: "session" }));
    capturedBytes = writer.byteLength;
    let nativeSessionId: string | null = null;
    let sidecarImageDigest: string | null = null;
    let sidecarBundleRevision: string | null = null;
    let nativeReason: string | null = "raw-session-capture-capability-absent";
    let evidenceSources: TangleEvidenceSourceLike[] = [];
    if (native !== undefined) {
      let manifestSource: object = native;
      const contentRefs: Array<{ jsonPointer: string; path: string }> = [];
      if (native.sessionId !== id || native.backendType !== options.harness) {
        throw new Error("Tangle raw evidence returned an unrelated session or profile backend");
      }
      if (native.nativeSessionId != null && !safeIdentifier(native.nativeSessionId)) {
        throw new Error("Tangle raw evidence native session id is invalid");
      }
      nativeSessionId = native.nativeSessionId ?? null;
      if (native.status === "captured" || native.status === "partial") {
        const declaredPartial = native.status === "partial";
        let partial = declaredPartial || admissionMissing.length > 0;
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
            !Array.isArray(native.processSources) || !Array.isArray(native.evidenceSources) ||
            !Array.isArray(native.excluded) || !Array.isArray(native.nativeRoots) || !native.inventory ||
            !Array.isArray(native.processTerminals) || typeof native.coverageComplete !== "boolean" ||
            !Array.isArray(native.missingReasons) || native.missingReasons.some((reason) => !safeReason(reason))) {
          throw new Error("Tangle raw session capture is malformed");
        }
        if ((!declaredPartial && (native.completeness.nativeStore !== true || native.completeness.processIo !== true ||
            native.completeness.events !== true || native.coverageComplete !== true || native.missingReasons.length > 0)) ||
            (declaredPartial && native.coverageComplete !== false)) {
          throw new Error("Tangle raw session capture is incomplete");
        }
        if (!Array.isArray(native.attempts) || native.attempts.length > MAX_ENTRIES) {
          throw new Error("Tangle raw session attempt inventory is missing or invalid");
        }
        const unattributedExecutions = [...new Set(native.attempts.filter(isEvidenceAttempt)
          .map((attempt) => attempt.executionId).filter((executionId) => !executionIds.includes(executionId)))];
        if (unattributedExecutions.length) {
          partial = true;
          for (const executionId of unattributedExecutions) {
            missing.push(`Sandbox session ${id} has an execution without retained caller attribution: ${executionId}`);
          }
        }
        const sessionAttempts = readNativeAttempts(native.attempts, executionIds, partial);
        const sourceBindings = new Map<string, TangleEvidenceSourceLike>();
        const sourceHomes = new Map<string, string>();
        for (const source of native.evidenceSources) {
          if (!source || !safeIdentifier(source.executionId) || !safeIdentifier(source.sourceId) ||
              source.backendType !== options.harness || !canonicalNativeRoot(source.runtimeHome) ||
              !Array.isArray(source.credentialPaths) || sourceBindings.has(source.executionId) ||
              (sourceHomes.has(source.sourceId) && sourceHomes.get(source.sourceId) !== source.runtimeHome)) {
            throw new Error("Tangle raw session evidence source identity is invalid");
          }
          for (const path of source.credentialPaths) canonicalEntryPath(path);
          sourceBindings.set(source.executionId, source);
          sourceHomes.set(source.sourceId, source.runtimeHome);
        }
        const sourceCoverage = executionIds.every((executionId) => sourceBindings.has(executionId)) &&
          native.evidenceSources.every((source) => executionIds.includes(source.executionId));
        if (!sourceCoverage) {
          if (!partial) throw new Error("Tangle raw session sources do not cover the exact executions");
          missing.push(`Sandbox session ${id} evidence sources do not cover the exact executions`);
        }
        evidenceSources = native.evidenceSources;
        let processAttributionComplete = sourceCoverage;
        const nativeEventCoverage = nativeEventsMatch(native.events, id, executionIds, partial);
        attempts.push(...sessionAttempts.filter((attempt) => executionIds.includes(attempt.executionId)));
        if (declaredPartial) missing.push(`Sandbox session ${id} declared partial raw capture`);
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
          if (!["session-home", "workspace-session"].includes(root.rootScope) || roots.has(nativeRootKey(root)) ||
              !canonicalNativeRoot(root.path) ||
              (root.sourceId !== undefined && (!safeIdentifier(root.sourceId) || !sourceHomes.has(root.sourceId) ||
                (root.rootScope === "session-home" && sourceHomes.get(root.sourceId) !== root.path)))) {
            throw new Error("Tangle raw session native root is invalid");
          }
          roots.add(nativeRootKey(root));
          nativeStore.roots.push({ scope: root.rootScope, path: root.path,
            ...(root.sourceId === undefined ? {} : { sourceId: root.sourceId }) });
        }
        if (!roots.size && (!partial || native.completeness.nativeStore)) throw new Error("Tangle raw session has no native root");
        const nativeRootCoverage = [...sourceHomes.keys()].every((sourceId) => roots.has(sourceId + "/session-home"));
        if (!nativeRootCoverage) {
          if (!partial) throw new Error("Tangle raw session has an unretained native source root");
          missing.push(`Sandbox session ${id} has an unretained native source root`);
        }
        const nativePaths = new Set<string>();
        const included = { file: 0, directory: 0, symlink: 0 };
        const excluded = { file: 0, directory: 0, symlink: 0 };
        for (const [index, entry] of native.files.entries()) {
          options.signal?.throwIfAborted();
          const path = canonicalEntryPath(entry.path);
          if (!roots.has(nativeRootKey(entry))) throw new Error("Tangle raw session entry has no native root");
          const identity = nativeRootKey(entry) + "/" + path;
          if (nativePaths.has(identity)) throw new Error("Tangle raw session repeats a native path");
          nativePaths.add(identity);
          if (!nativeStatMetadata(entry)) throw new Error("Tangle raw session entry metadata is invalid");
          if (entry.kind === "file") {
            const contentPath = "__retention__/sessions/" + id + "/native/" +
              (entry.sourceId === undefined ? "" : entry.sourceId + "/") + entry.rootScope + "/" + path;
            await retainNativeContent(entry, contentPath, entry.mode & 0o777);
            contentRefs.push({ jsonPointer: `/files/${index}/contentBase64`, path: contentPath });
            capturedBytes = writer.byteLength;
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
            ...(entry.sourceId === undefined ? {} : { sourceId: entry.sourceId }),
            rootScope: entry.rootScope, path, kind: entry.kind, mode: entry.mode,
            uid: entry.uid, gid: entry.gid, mtimeMs: entry.mtimeMs, ctimeMs: entry.ctimeMs,
            sizeBytes: entry.sizeBytes, sha256: entry.sha256 ?? null, linkTarget: entry.linkTarget ?? null,
          });
        }
        for (const exclusion of native.excluded) {
          const path = canonicalEntryPath(exclusion.path);
          const identity = nativeRootKey(exclusion) + "/" + path;
          if (!roots.has(nativeRootKey(exclusion)) || nativePaths.has(identity) ||
              exclusion.reason !== "credential" || !["file", "directory", "symlink"].includes(exclusion.kind) ||
              !nativeStatMetadata(exclusion)) {
            throw new Error("Tangle raw session exclusion is invalid");
          }
          nativePaths.add(identity);
          excluded[exclusion.kind] += 1;
          nativeStore.excludedPaths.push({
            ...(exclusion.sourceId === undefined ? {} : { sourceId: exclusion.sourceId }),
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
        if (native.skipped !== undefined) {
          if (!Array.isArray(native.skipped) || native.skipped.length !== inventory.skippedEntries ||
              native.skipped.some((entry) => !roots.has(nativeRootKey(entry)) || !safeReason(entry.reason))) {
            throw new Error("Tangle raw session skipped inventory does not reconcile");
          }
          for (const entry of native.skipped) {
            if (entry.path !== ".") canonicalEntryPath(entry.path);
          }
        }
        const ioSequences = new Map<string, Set<number>>();
        const frameMetadata: Array<Record<string, unknown>> = [];
        for (const [index, frame] of native.processIo.entries()) {
          options.signal?.throwIfAborted();
          if (!safeIdentifier(frame.processId) || (frame.sourceId !== undefined && !safeIdentifier(frame.sourceId)) ||
              !Number.isSafeInteger(frame.sequence) ||
              frame.sequence < 0 || !Number.isFinite(Date.parse(frame.at)) ||
              !["stdin", "stdout", "stderr", "protocol"].includes(frame.stream)) {
            throw new Error("Tangle raw session process stream metadata is invalid");
          }
          const processKey = sourceProcessKey(frame);
          const sequences = ioSequences.get(processKey) ?? new Set<number>();
          if (sequences.has(frame.sequence)) throw new Error("Tangle raw session repeats a process frame");
          sequences.add(frame.sequence);
          ioSequences.set(processKey, sequences);
          if (!processAttemptMatches(frame, sessionAttempts, partial)) {
            processAttributionComplete = false;
            missing.push(`Sandbox session ${id} process ${frame.processId} has no exact attempt attribution`);
          }
          if (frame.sourceId === undefined || sourceBindings.get(frame.executionId ?? "")?.sourceId !== frame.sourceId) {
            if (!partial) throw new Error("Tangle raw session process has conflicting source attribution");
            processAttributionComplete = false;
            missing.push(`Sandbox session ${id} process ${frame.processId} has no exact source attribution`);
          }
          const label = String(frame.sequence).padStart(16, "0");
          const contentPath = "__retention__/sessions/" + id + "/io/" +
            (frame.sourceId === undefined ? "" : frame.sourceId + "/") + frame.processId + "/" + label +
            "-" + frame.stream + ".bin";
          const contentSize = await retainNativeContent(frame, contentPath, 0o600);
          contentRefs.push({ jsonPointer: `/processIo/${index}/contentBase64`, path: contentPath });
          frameMetadata.push(withoutNativeContent(frame));
          capturedBytes = writer.byteLength;
          const counter = (frame.stream + "Bytes") as "stdinBytes" | "stdoutBytes" | "stderrBytes" | "protocolBytes";
          processStreams[counter] += contentSize;
          processStreams.streamCount += 1;
        }
        const terminals = new Set<string>();
        for (const terminal of native.processTerminals) {
          const processKey = sourceProcessKey(terminal);
          if (!safeIdentifier(terminal.processId) || (terminal.sourceId !== undefined && !safeIdentifier(terminal.sourceId)) ||
              terminals.has(processKey) ||
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
          const sequences = ioSequences.get(processKey) ?? new Set<number>();
          if (!processAttemptMatches(terminal, sessionAttempts, partial)) {
            processAttributionComplete = false;
            missing.push(`Sandbox session ${id} terminal ${terminal.processId} has no exact attempt attribution`);
          }
          if (terminal.sourceId === undefined || sourceBindings.get(terminal.executionId ?? "")?.sourceId !== terminal.sourceId) {
            if (!partial) throw new Error("Tangle raw session terminal has conflicting source attribution");
            processAttributionComplete = false;
            missing.push(`Sandbox session ${id} terminal ${terminal.processId} has no exact source attribution`);
          }
          if (!partial && (terminal.sequence !== sequences.size ||
              [...sequences].some((sequence) => sequence < 0 || sequence >= terminal.sequence))) {
            throw new Error("Tangle raw session process sequence is incomplete");
          }
          terminals.add(processKey);
          processStreams.terminals.push(terminal);
        }
        if (!partial && [...ioSequences.keys()].some((processId) => !terminals.has(processId))) {
          throw new Error("Tangle raw session has a process without a terminal receipt");
        }
        const observedProcesses = [...native.processIo, ...native.processTerminals];
        const observedAttemptProcesses = new Set(observedProcesses.map(attemptProcessKey));
        for (const attempt of sessionAttempts) {
          for (const processId of attempt.processIds) {
            const key = attemptProcessKey({ ...attempt, processId,
              sourceId: sourceBindings.get(attempt.executionId)?.sourceId });
            if (observedAttemptProcesses.has(key)) continue;
            if (!partial) throw new Error("Tangle raw session attempt names an unretained attributed process");
            processAttributionComplete = false;
            missing.push(`Sandbox session ${id} attempt ${attempt.executionId}/${attempt.ordinal} names an unretained attributed process: ${processId}`);
          }
        }
        processStreams.processCount = new Set([...ioSequences.keys(), ...terminals]).size;
        processStreams.terminalCount = terminals.size;
        const spoolSources = new Set<string>();
        for (const [index, processSource] of native.processSources.entries()) {
          if (!safeIdentifier(processSource.sourceId) || !sourceHomes.has(processSource.sourceId) ||
              spoolSources.has(processSource.sourceId)) throw new Error("Tangle raw session process source identity is invalid");
          spoolSources.add(processSource.sourceId);
          const sourcePath = "__retention__/sessions/" + id + "/process-sources/" + processSource.sourceId + ".jsonl";
          const sourceSize = await retainNativeContent(processSource, sourcePath, 0o600);
          capturedBytes = writer.byteLength;
          processStreams.sources.push({ sourceId: processSource.sourceId, path: sourcePath, sizeBytes: sourceSize, sha256: processSource.sha256 });
          contentRefs.push({ jsonPointer: `/processSources/${index}/contentBase64`, path: sourcePath });
        }
        const missingSpoolSources = [...sourceHomes.keys()].filter((sourceId) => !spoolSources.has(sourceId));
        if (!partial && missingSpoolSources.length > 0) {
          throw new Error("Tangle raw session omits an original process source");
        }
        for (const sourceId of missingSpoolSources) {
          missing.push(`Sandbox session ${id} has no original process source: ${sourceId}`);
        }
        manifestSource = {
          ...native,
          files: native.files.map((entry) => entry.kind === "file" ? withoutNativeContent(entry) : entry),
          processIo: frameMetadata,
          processSources: native.processSources.map(withoutNativeContent),
        };
        nativeStore.complete = sourceCoverage && nativeRootCoverage && native.completeness.nativeStore && inventory.skippedEntries === 0 &&
          inventory.scannedFiles === inventory.reportedFiles + inventory.excludedFiles &&
          inventory.scannedDirectories === inventory.reportedDirectories + inventory.excludedDirectories &&
          inventory.scannedSymlinks === inventory.reportedSymlinks + inventory.excludedSymlinks;
        processStreams.complete = missingSpoolSources.length === 0 && processAttributionComplete && native.completeness.processIo && [...ioSequences.keys()].every((processId) => terminals.has(processId)) &&
          native.processTerminals.every((terminal) => {
            const sequences = ioSequences.get(sourceProcessKey(terminal)) ?? new Set<number>();
            return terminal.result.captureError === null && terminal.sequence === sequences.size &&
              [...sequences].every((sequence) => sequence >= 0 && sequence < terminal.sequence);
          });
        nativeEvents.complete = sourceCoverage && unattributedExecutions.length === 0 && native.completeness.events && nativeEventCoverage;
        nativeEvents.count = native.events.length;
        nativeReason = partial ? (native.missingReasons.join("; ") || "incomplete-execution-attribution") : null;
      } else if (native.status === "unavailable") {
        if (!safeReason(native.reason)) throw new Error("Tangle raw session unavailability reason is invalid");
        nativeReason = native.reason;
      } else {
        throw new Error("Tangle raw session capture status is invalid");
      }
      await writer.writeChunks("__retention__/sessions/" + id + "/raw-manifest.json", 0o600,
        evidenceJsonChunks({ kind: "tangle-native-session-evidence.v1", source: manifestSource,
          contentEncoding: "base64", contentRefs }));
      capturedBytes = writer.byteLength;
    }
    sessions.push({
      id, executionId: artifactExecutionId, executionIds: [...executionIds], eventCountsByExecutionId,
      ...(recoveredControlRefs.length ? { controlRefs: recoveredControlRefs } : {}),
      backendType: options.harness, sidecarImageDigest, sidecarBundleRevision,
      transportEvents: executionIds.every((executionId) => eventCountsByExecutionId[executionId] > 0) ? "complete" : "unavailable",
      eventCount: counts.events, messageCount: counts.messages, messageScope: "session",
      nativeSessionId, nativeReason, nativeStore, processStreams, nativeEvents,
      evidenceSources,
    });
    for (const executionId of executionIds) {
      if (!eventCountsByExecutionId[executionId]) {
        missing.push("Sandbox session " + id + " returned no events for execution " + executionId);
      }
    }
    if (!nativeStore.complete || !processStreams.complete || !nativeEvents.complete) {
      missing.push("Raw native session capture for Sandbox session " + id + " is unavailable: " + nativeReason);
    }
    } finally { await prepared?.remove(); }
  }
  const provenance: TangleEnvironmentEvidence["provenance"] = {
    provider: controlRef?.provider ?? "tangle-sandbox",
    environmentId: box.id,
    executionId: artifactExecutionId,
    ...(controlRef === undefined ? {} : { controlRef }),
    ...(captureProof ? { captureProof } : {}),
    workspaceScope,
    workspaceRoot,
    capturedAt: new Date().toISOString(),
    entries: metadata.sort((a, b) => a.path.localeCompare(b.path)),
    excludedPaths,
    workspace: { scannedFiles, scannedDirectories, reportedFiles: usage.fileCount, reportedDirectories: usage.directoryCount, complete: workspaceScope === "environment" },
    attempts,
    sessions,
    missing,
  };
  const provenanceBytes = Buffer.from(JSON.stringify({ kind: "tangle-evidence-provenance.v1", ...provenance }));
  if (capturedBytes + provenanceBytes.byteLength > options.maxBytes) throw new Error("Tangle evidence exceeds byte limit");
  await writer.write({ path: "__retention__/provenance.json", bytes: provenanceBytes, mode: 0o600 });
  return provenance;
}

/** Match every response to exactly one request before accepting any file bytes. */
async function readWorkspaceEvidenceBatch(
  fs: NonNullable<SandboxInstanceLike["fs"]>,
  entries: readonly WorkspaceFileRead[],
  maxBytes: number,
  signal?: AbortSignal,
): Promise<TangleEnvironmentEvidence["files"]> {
  signal?.throwIfAborted();
  const result = await fs.readBatch(entries.map((entry) => entry.sourcePath), { encoding: "base64" });
  signal?.throwIfAborted();
  if (!result || !Array.isArray(result.files) || !Array.isArray(result.errors)) {
    throw new Error("Tangle evidence workspace batch response is malformed");
  }
  const expected = new Set(entries.map((entry) => entry.sourcePath));
  const returned = new Set<string>();
  for (const item of [...result.files, ...result.errors]) {
    if (!expected.has(item.path) || returned.has(item.path)) {
      throw new Error("Tangle evidence workspace batch contains an unexpected or repeated path");
    }
    returned.add(item.path);
  }
  if (returned.size !== expected.size) throw new Error("Tangle evidence workspace batch omitted a requested path");
  const reads = new Map(result.files.map((read) => [read.path, read]));
  const errors = new Map(result.errors.map((error) => [error.path, error]));
  const files: TangleEnvironmentEvidence["files"] = [];
  let remainingBytes = maxBytes;
  for (const entry of entries) {
    signal?.throwIfAborted();
    const read = reads.get(entry.sourcePath);
    const error = errors.get(entry.sourcePath);
    let bytes: Buffer;
    if (error?.code === "FILE_TOO_LARGE") {
      bytes = await downloadWorkspaceEvidenceFile(fs, entry.sourcePath, entry.size, remainingBytes, signal);
    } else {
      if (error || !read || read.encoding !== "base64") {
        throw new Error(`Tangle evidence could not read workspace file ${entry.path}`);
      }
      bytes = Buffer.from(read.content, "base64");
      if (bytes.byteLength !== entry.size || read.size !== entry.size || bytes.toString("base64") !== read.content) {
        throw new Error(`Tangle evidence workspace file changed or was truncated: ${entry.path}`);
      }
      if (read.hash && read.hash.replace(/^sha256:/, "") !== createHash("sha256").update(bytes).digest("hex")) {
        throw new Error(`Tangle evidence workspace file hash mismatch: ${entry.path}`);
      }
    }
    if (bytes.byteLength > remainingBytes) throw new Error("Tangle evidence exceeds byte limit");
    files.push({ path: entry.path, bytes, mode: entry.mode });
    remainingBytes -= bytes.byteLength;
  }
  return files;
}

/** The JSON reader has a smaller transport cap than an evidence archive. */
async function downloadWorkspaceEvidenceFile(
  fs: NonNullable<SandboxInstanceLike["fs"]>,
  sourcePath: string,
  expectedSize: number,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (fs.supportsBoundedDownload !== true || !fs.download) {
    throw new Error(`Tangle evidence requires bounded binary download for workspace file ${sourcePath}`);
  }
  const local = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  signal?.throwIfAborted();
  const directory = await local.mkdtemp(join(tmpdir(), "tangle-evidence-"));
  try {
    const target = join(directory, "content");
    const receipt = await fs.download(sourcePath, target, { maxBytes, expectedSize, signal });
    signal?.throwIfAborted();
    if (!receipt || receipt.sizeBytes !== expectedSize || !/^[a-f0-9]{64}$/i.test(receipt.sha256)) {
      throw new Error("Tangle evidence binary download omitted its exact size or digest receipt");
    }
    const metadata = await local.stat(target);
    if (!metadata.isFile() || metadata.size !== expectedSize || metadata.size > maxBytes) {
      throw new Error(`Tangle evidence workspace file changed or was truncated: ${sourcePath}`);
    }
    const bytes = await local.readFile(target, { signal });
    if (bytes.byteLength !== expectedSize || bytes.byteLength > maxBytes) {
      throw new Error(`Tangle evidence workspace file changed or was truncated: ${sourcePath}`);
    }
    if (createHash("sha256").update(bytes).digest("hex") !== receipt.sha256.toLowerCase()) {
      throw new Error(`Tangle evidence workspace file hash mismatch: ${sourcePath}`);
    }
    return bytes;
  } finally {
    await local.rm(directory, { recursive: true, force: true });
  }
}

/** Keep every source field; store validated binary content once in the archive. */
function withoutNativeContent(source: object): Record<string, unknown> {
  const metadata: Record<string, unknown> = { ...source };
  delete metadata.contentBase64;
  return metadata;
}

function safeIdentifier(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function safeReason(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
}

function nativeRootKey(value: { rootScope: string; sourceId?: string }): string {
  return `${value.sourceId ?? ""}/${value.rootScope}`;
}

function sourceProcessKey(value: { processId: string; sourceId?: string }): string {
  return `${value.sourceId ?? ""}/${value.processId}`;
}

function attemptProcessKey(value: { processId: string; sourceId?: string; executionId?: string; ordinal?: number; providerSessionId?: string }): string {
  return `${sourceProcessKey(value)}/${value.executionId ?? ""}/${value.ordinal ?? ""}/${value.providerSessionId ?? ""}`;
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
    if (!isEvidenceAttempt(entry) || (!partial && !executionIds.includes(entry.executionId))) {
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
  const owners = attempts.filter((attempt) => attempt.processIds.includes(value.processId) &&
    attempt.executionId === value.executionId && attempt.ordinal === value.ordinal &&
    attempt.providerSessionId === value.providerSessionId);
  const exact = owners.length === 1;
  if (!exact && !partial) throw new Error("Tangle raw session process has missing or conflicting attempt attribution");
  return exact;
}

function nativeEventsMatch(events: readonly unknown[], sessionId: string, executionIds: readonly string[], partial: boolean): boolean {
  const seen = new Set<string>();
  let countsComplete = true;
  for (const event of events) {
    if (event === null || typeof event !== "object") throw new Error("Tangle raw session event buffer is malformed");
    const entry = event as Record<string, unknown>;
    if (entry.metadata === null || typeof entry.metadata !== "object" ||
        !(Array.isArray(entry.frames) || entry.frames instanceof EvidenceJsonArray)) {
      throw new Error("Tangle raw session event buffer is malformed");
    }
    const metadata = entry.metadata as Record<string, unknown>;
    if (metadata.sessionId !== sessionId || typeof metadata.executionId !== "string" ||
        !safeIdentifier(metadata.executionId) || (!partial && !executionIds.includes(metadata.executionId)) || seen.has(metadata.executionId)) {
      throw new Error("Tangle raw session event buffer has unrelated or duplicate execution identity");
    }
    const frameCount = entry.frames instanceof EvidenceJsonArray ? entry.frames.count : entry.frames.length;
    if (!Number.isSafeInteger(metadata.eventCount) || Number(metadata.eventCount) < 0 || metadata.eventCount !== frameCount) {
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

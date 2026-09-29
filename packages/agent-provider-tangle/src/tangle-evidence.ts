import { createHash } from "node:crypto";
import { parseBackendType } from "@tangle-network/sandbox";
import type { AgentProfile } from "@tangle-network/agent-interface";
import type { AgentEnvironment } from "@tangle-network/agent-interface/environment-provider";
import type { SandboxClientLike, SandboxInstanceLike } from "./tangle-types.js";

const handles = new WeakMap<AgentEnvironment, { box: SandboxInstanceLike; sessions: Map<string, Set<string>> }>();
const blockedNames = new Set([".ssh", ".config", ".claude", ".codex", ".opencode", ".env", ".env.local", ".npmrc", ".sidecar"]);
const MAX_ENTRIES = 100_000;
const MAX_EVENTS = 100_000;
const verifiedCapabilities = new WeakSet<object>();

export interface TangleEvidenceCapabilities {
  readonly workspaceCaptureV1: true;
  readonly nativeSessionCaptureV1: true;
  readonly sidecarImageDigest: string;
}

/** Read a deployment guarantee once, before Runtime starts creating environments. */
export async function readTangleEvidenceCapabilities(client: SandboxClientLike): Promise<TangleEvidenceCapabilities> {
  if (typeof client.evidenceCapabilities !== "function") throw new Error("Tangle deployment has no pre-create evidence capability query");
  const document = await client.evidenceCapabilities();
  if (document?.workspaceCaptureV1 !== true || document.nativeSessionCaptureV1 !== true ||
      !/^sha256:[0-9a-f]{64}$/.test(document.sidecarImageDigest ?? "")) {
    throw new Error("Tangle deployment has not proven complete workspace and native session capture for next-create placement");
  }
  const verified = Object.freeze({
    workspaceCaptureV1: true as const,
    nativeSessionCaptureV1: true as const,
    sidecarImageDigest: document.sidecarImageDigest as string,
  });
  verifiedCapabilities.add(verified);
  return verified;
}

/** The generic guarantee covers the profile's exact backend without a provider-side harness list. */
export function assertTangleEvidenceProfileCapability(document: TangleEvidenceCapabilities, profile: AgentProfile): void {
  if (!verifiedCapabilities.has(document)) throw new Error("Tangle evidence capability was not read from the deployment");
  if (!profile.harness) throw new Error("Tangle complete native session capture requires an exact profile harness");
  parseBackendType(profile.harness);
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
  /** Optional next-create proof to compare with the running sidecar image. */
  expectedSidecarImageDigest?: string;
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
    workspaceScope: "environment";
    workspaceRoot: string;
    capturedAt: string;
    entries: WorkspaceEntryMetadata[];
    excludedPaths: Array<WorkspaceEntryMetadata & { reason: "credential-path" | "symlink" | "runtime-owned" }>;
    workspace: { scannedFiles: number; scannedDirectories: number; reportedFiles: number; reportedDirectories: number; complete: true };
    sessions: Array<{
      id: string;
      executionId: string;
      executionIds: string[];
      eventCountsByExecutionId: Record<string, number>;
      backendType: string;
      sidecarImageDigest: string | null;
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
          skippedEntries: 0;
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
        terminals: Array<{ processId: string; sequence: number; at: string; result: {
          code: number | null; signal: string | null; timedOut: boolean; timeoutReason: string | null;
          captureError: null; spawnError?: string;
        } }>;
      };
      nativeEvents: { complete: boolean; count: number };
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
    const native = await session.rawEvidence?.();
    const nativeStore: TangleEnvironmentEvidence["provenance"]["sessions"][number]["nativeStore"] = {
      scope: "session", roots: [], inventory: null, complete: false, entries: [], excludedPaths: [],
    };
    const processStreams: TangleEnvironmentEvidence["provenance"]["sessions"][number]["processStreams"] = {
      complete: false, streamCount: 0, processCount: 0, terminalCount: 0,
      stdinBytes: 0, stdoutBytes: 0, stderrBytes: 0, protocolBytes: 0, terminals: [],
    };
    const nativeEvents: TangleEnvironmentEvidence["provenance"]["sessions"][number]["nativeEvents"] = {
      complete: false, count: 0,
    };
    let nativeSessionId: string | null = null;
    let sidecarImageDigest: string | null = null;
    let nativeReason: string | null = "raw-session-capture-capability-absent";
    if (native !== undefined) {
      if (native.sessionId !== id || native.backendType !== options.harness) {
        throw new Error("Tangle raw evidence returned an unrelated session or profile backend");
      }
      if (native.nativeSessionId !== undefined && !safeIdentifier(native.nativeSessionId)) {
        throw new Error("Tangle raw evidence native session id is invalid");
      }
      nativeSessionId = native.nativeSessionId ?? null;
      if (native.status === "captured") {
        if (!/^sha256:[0-9a-f]{64}$/.test(native.sidecarImageDigest) ||
            (options.expectedSidecarImageDigest !== undefined &&
             native.sidecarImageDigest !== options.expectedSidecarImageDigest)) {
          throw new Error("Tangle raw session image digest is missing or differs from deployment proof");
        }
        sidecarImageDigest = native.sidecarImageDigest;
        if (native.completeness?.nativeStore !== true || native.completeness.processIo !== true ||
            native.completeness.events !== true || !Array.isArray(native.files) ||
            !Array.isArray(native.processIo) || !Array.isArray(native.events) ||
            !Array.isArray(native.excluded) || !Array.isArray(native.nativeRoots) || !native.inventory ||
            !Array.isArray(native.processTerminals) || native.coverageComplete !== true) {
          throw new Error("Tangle raw session capture is incomplete");
        }
        if (native.files.length + native.processIo.length + native.processTerminals.length +
            native.events.length > MAX_ENTRIES) {
          throw new Error("Tangle raw session capture exceeds entry limit");
        }
        const roots = new Set<string>();
        for (const root of native.nativeRoots) {
          if (!["session-home", "workspace-session"].includes(root.scope) || roots.has(root.scope) ||
              (root.path !== "." && canonicalEntryPath(root.path) !== root.path)) {
            throw new Error("Tangle raw session native root is invalid");
          }
          roots.add(root.scope);
          nativeStore.roots.push(root);
        }
        if (!roots.size) throw new Error("Tangle raw session has no native root");
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
            inventory.skippedEntries !== 0 ||
            inventory.reportedFiles !== included.file ||
            inventory.reportedDirectories !== included.directory ||
            inventory.reportedSymlinks !== included.symlink ||
            inventory.excludedFiles !== excluded.file ||
            inventory.excludedDirectories !== excluded.directory ||
            inventory.excludedSymlinks !== excluded.symlink ||
            inventory.scannedFiles !== inventory.reportedFiles + inventory.excludedFiles ||
            inventory.scannedDirectories !== inventory.reportedDirectories + inventory.excludedDirectories ||
            inventory.scannedSymlinks !== inventory.reportedSymlinks + inventory.excludedSymlinks) {
          throw new Error("Tangle raw session inventory does not reconcile");
        }
        nativeStore.inventory = inventory;
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
          const content = exactNativeBytes(frame.contentBase64, frame.sizeBytes, frame.sha256,
            options.maxBytes - capturedBytes);
          if (capturedBytes + content.byteLength > options.maxBytes) throw new Error("Tangle evidence exceeds byte limit");
          const label = String(frame.sequence).padStart(16, "0");
          files.push({ path: "__retention__/sessions/" + id + "/io/" + frame.processId + "/" + label +
            "-" + frame.stream + ".bin", bytes: content, mode: 0o600 });
          frameMetadata.push({
            processId: frame.processId, sequence: frame.sequence, at: frame.at, stream: frame.stream,
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
              terminal.result?.captureError !== null ||
              !(terminal.result.code === null || Number.isSafeInteger(terminal.result.code)) ||
              !(terminal.result.signal === null || typeof terminal.result.signal === "string") ||
              typeof terminal.result.timedOut !== "boolean" ||
              !(terminal.result.timeoutReason === null || typeof terminal.result.timeoutReason === "string") ||
              (terminal.result.spawnError !== undefined && typeof terminal.result.spawnError !== "string")) {
            throw new Error("Tangle raw session process terminal metadata is invalid");
          }
          const sequences = ioSequences.get(terminal.processId) ?? new Set<number>();
          if (terminal.sequence !== sequences.size ||
              [...sequences].some((sequence) => sequence < 0 || sequence >= terminal.sequence)) {
            throw new Error("Tangle raw session process sequence is incomplete");
          }
          terminals.add(terminal.processId);
          processStreams.terminals.push(terminal);
        }
        if ([...ioSequences.keys()].some((processId) => !terminals.has(processId))) {
          throw new Error("Tangle raw session has a process without a terminal receipt");
        }
        processStreams.processCount = terminals.size;
        processStreams.terminalCount = terminals.size;
        const processManifest = Buffer.from(JSON.stringify({
          kind: "tangle-native-process-streams.v1", sessionId: id,
          frames: frameMetadata, terminals: native.processTerminals,
        }));
        if (capturedBytes + processManifest.byteLength > options.maxBytes) throw new Error("Tangle evidence exceeds byte limit");
        files.push({ path: "__retention__/sessions/" + id + "/process-manifest.json",
          bytes: processManifest, mode: 0o600 });
        capturedBytes += processManifest.byteLength;
        const nativeEventBytes = Buffer.from(JSON.stringify({
          kind: "tangle-native-session-events.v1", sessionId: id, backendType: native.backendType,
          nativeSessionId, events: native.events,
        }));
        if (capturedBytes + nativeEventBytes.byteLength > options.maxBytes) throw new Error("Tangle evidence exceeds byte limit");
        files.push({ path: "__retention__/sessions/" + id + "/native-events.json", bytes: nativeEventBytes, mode: 0o600 });
        capturedBytes += nativeEventBytes.byteLength;
        nativeStore.complete = true;
        processStreams.complete = true;
        nativeEvents.complete = true;
        nativeEvents.count = native.events.length;
        nativeReason = null;
      } else {
        if (!safeIdentifier(native.reason)) throw new Error("Tangle raw session unavailability reason is invalid");
        nativeReason = native.reason;
      }
    }
    sessions.push({
      id, executionId: options.executionId, executionIds: [...executionIds], eventCountsByExecutionId,
      backendType: options.harness, sidecarImageDigest,
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
    workspaceScope: "environment",
    workspaceRoot,
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

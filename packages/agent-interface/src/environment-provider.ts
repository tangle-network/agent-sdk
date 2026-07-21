import type {
  AgentProfile,
  AgentProfileCapabilities,
  AgentProfileValidationResult,
} from "./agent-profile.js";
import type { AgentCandidateTermination } from "./agent-candidate.js";
import type { InputPart, StreamEvent, TokenUsage } from "./index.js";

/** Portable profile reference: inline profile or provider catalog id. */
export type AgentProfileRef = AgentProfile | string;

export type AgentEnvironmentStatus =
  | "pending"
  | "provisioning"
  | "running"
  | "stopped"
  | "failed"
  | "expired"
  | "unknown";

export type AgentSessionStatus =
  | AgentEnvironmentStatus
  | "completed"
  | "cancelled";

export interface WorkspaceRequest {
  /** Provider-specific environment/template id, for example "universal". */
  environment?: string;
  /** Container image or image alias when the provider supports image-backed workspaces. */
  image?: string;
  /** Repository to clone or mount before the agent runs. */
  repoUrl?: string;
  /** Git ref for {@link repoUrl}. */
  gitRef?: string;
  /** Initial working directory inside the environment. */
  cwd?: string;
  /** Opaque provider-native workspace fields. */
  providerOptions?: Record<string, unknown>;
}

export interface ResourceRequest {
  cpu?: number;
  memoryMb?: number;
  diskMb?: number;
  gpu?: string;
  providerOptions?: Record<string, unknown>;
}

export interface AgentEnvironmentQuery {
  name?: string;
  metadata?: Record<string, unknown>;
  providerOptions?: Record<string, unknown>;
}

export interface AgentEnvironmentSummary {
  id: string;
  provider: string;
  name?: string;
  status?: AgentEnvironmentStatus;
  metadata?: Record<string, unknown>;
}

export interface ExecRequest {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type AgentExactProcessEgressMode = "blocked" | "strict";

/**
 * Outbound network policy for an exact process environment. `blocked` denies
 * every protocol. `strict` permits only the named domains; direct-address,
 * alternate-protocol, and cross-environment bypasses must fail.
 */
export type AgentExactProcessEgressPolicy =
  | { mode: "blocked" }
  | { mode: "strict"; allowDomains: readonly string[] };

/** Explicit portable limits for an exact process environment. */
export interface AgentExactProcessResources {
  /** Positive CPU core count. */
  cpu: number;
  /** Positive integer mebibytes of memory. */
  memoryMb: number;
  /** Positive integer mebibytes of disk. */
  diskMb: number;
}

/** Terminal or running state reported by an exact process host. */
export interface AgentExactProcessStatus {
  pid: number;
  /** Opaque launch identity when the process was started with one. */
  idempotencyKey?: string;
  running: boolean;
  /** -1 while running; the exact process exit code after termination. */
  exitCode: number;
  exitSignal?: string;
  /** Required after termination; absent only while running. */
  termination?: AgentCandidateTermination;
}

/** Recoverable handle for one shell-free process. */
export interface AgentExactProcess {
  readonly pid: number;
  status(): Promise<AgentExactProcessStatus>;
  wait(): Promise<AgentCandidateTermination>;
  /** Force-stop the full process tree. Idempotent after the process exits. */
  kill(): Promise<void>;
  /** Each iteration replays buffered UTF-8 stdout, then continues until exit. */
  stdout(): AsyncIterable<string>;
  /** Each iteration replays buffered UTF-8 stderr, then continues until exit. */
  stderr(): AsyncIterable<string>;
}

/** Shell-free launch whose environment replaces, rather than extends, ambient variables. */
export interface AgentExactProcessLaunch {
  /** Absolute path unless {@link env} supplies an explicit `PATH`. */
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdin?: string;
  /** Positive integer milliseconds, or zero to disable the process timeout. */
  timeoutMs: number;
  /**
   * Opaque, non-secret launch identity.
   * Repeating the same key and identical launch returns the same process while
   * its terminal record is retained; a changed launch with the same key fails.
   */
  idempotencyKey?: string;
  /**
   * Minimum terminal-record retention after exit.
   * Valid only with {@link idempotencyKey}; providers fail before launch when
   * they cannot honor it.
   */
  retentionMs?: number;
}

/** Select retained exact-process records by their stable launch identity. */
export interface AgentExactProcessQuery {
  idempotencyKey?: string;
}

export interface AgentExactProcessManager {
  /** Every supplied query field must match the returned process status exactly. */
  list(query?: AgentExactProcessQuery): Promise<AgentExactProcessStatus[]>;
  get(pid: number): Promise<AgentExactProcess | null>;
  /**
   * Providers must honor the abort signal when supplied.
   * A keyed launch returns a process whose status preserves that key.
   */
  spawn(
    input: AgentExactProcessLaunch,
    options?: { signal?: AbortSignal },
  ): Promise<AgentExactProcess>;
}

/**
 * Fresh environment with no provider-managed user workload.
 *
 * Authenticated provider control services may exist, but no customer workload
 * ingress or provider-managed user process may exist. The launched process
 * sees only its supplied environment variables, with no ambient or injected
 * secrets.
 */
export interface AgentExactProcessEnvironment {
  readonly id: string;
  readonly provider: string;
  readonly metadata?: Record<string, unknown>;
  readonly process: AgentExactProcessManager;
  /** Write exact bytes to an absolute path with a POSIX mode from 0 through 07777. Providers must honor the abort signal when supplied. */
  writeFile(
    path: string,
    bytes: Uint8Array,
    options: { mode: number; signal?: AbortSignal },
  ): Promise<void>;
  /** Read exact bytes or fail before content is loaded when the file exceeds maxBytes. */
  readFile(
    path: string,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<Uint8Array>;
  destroy(): Promise<void>;
}

export interface AgentExactProcessEnvironmentQuery {
  /** Every supplied key/value must match persisted environment metadata exactly. */
  metadata?: Record<string, unknown>;
  providerOptions?: Record<string, unknown>;
}

/** Input for a fresh environment with no provider-managed agent process. */
export interface CreateAgentExactProcessEnvironmentInput {
  /** Provider-specific immutable image reference. */
  image: string;
  egress: AgentExactProcessEgressPolicy;
  /** Positive integer milliseconds. */
  maxLifetimeMs: number;
  /** Positive integer milliseconds when supplied. */
  provisionTimeoutMs?: number;
  /** Required limits; exact execution never inherits provider defaults. */
  resources: AgentExactProcessResources;
  metadata: Record<string, unknown>;
  idempotencyKey: string;
  signal?: AbortSignal;
  /** Provider-native fields may narrow, but never weaken, the isolation contract. */
  providerOptions?: Record<string, unknown>;
}

/** Optional all-or-nothing exact process capability of an environment provider. */
export interface AgentExactProcessProvider {
  /**
   * Repeating the same idempotency key and input returns the same environment.
   * Reusing the key with any different create input must fail.
   * Unsupported egress modes must fail instead of weakening the policy.
   */
  create(input: CreateAgentExactProcessEnvironmentInput): Promise<AgentExactProcessEnvironment>;
  /** Ordinary environments must return null. */
  get(id: string): Promise<AgentExactProcessEnvironment | null>;
  /** Return every matching exact environment; providers own any native pagination. */
  list(query?: AgentExactProcessEnvironmentQuery): Promise<AgentExactProcessEnvironment[]>;
}

export interface CheckpointRequest {
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface CheckpointRef {
  id: string;
  provider?: string;
  metadata?: Record<string, unknown>;
}

export interface ForkRequest {
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface PlacementInfo {
  kind: "local" | "sandbox" | "fleet" | "provider";
  sandboxId?: string;
  fleetId?: string;
  machineId?: string;
  region?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface AgentTurnInput {
  prompt?: string;
  parts?: InputPart[];
  sessionId?: string;
  model?: string;
  timeoutMs?: number;
  executionId?: string;
  lastEventId?: string;
  turnId?: string;
  detach?: boolean;
  context?: Record<string, unknown>;
  signal?: AbortSignal;
  providerOptions?: Record<string, unknown>;
}

export interface AgentTurnResult {
  text: string;
  success: boolean;
  error?: string;
  sessionId?: string;
  usage?: TokenUsage;
  metadata?: Record<string, unknown>;
  events?: AgentEnvironmentEvent[];
}

export interface AgentSessionRef {
  id: string;
  provider?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentEnvironmentEvent {
  type: string;
  data: Record<string, unknown>;
  id?: string;
  normalized?: StreamEvent;
  usage?: TokenUsage;
  providerEvent?: unknown;
}

export interface AgentSession {
  readonly id: string;
  status(): Promise<AgentSessionStatus | null>;
  events(options?: {
    since?: string;
    signal?: AbortSignal;
  }): AsyncIterable<AgentEnvironmentEvent>;
  result(): Promise<AgentTurnResult>;
  prompt(input: AgentTurnInput): Promise<AgentTurnResult>;
  cancel(): Promise<void>;
}

export interface AgentEnvironment {
  readonly id: string;
  readonly provider: string;
  readonly name?: string;
  status(): Promise<AgentEnvironmentStatus>;
  stream(input: AgentTurnInput): AsyncIterable<AgentEnvironmentEvent>;
  dispatch?(input: AgentTurnInput): Promise<AgentSessionRef>;
  session?(id: string): AgentSession;
  read?(path: string, options?: { sessionId?: string }): Promise<string>;
  write?(
    path: string,
    content: string,
    options?: { sessionId?: string },
  ): Promise<void>;
  exec?(command: string, options?: ExecRequest): Promise<ExecResult>;
  checkpoint?(options?: CheckpointRequest): Promise<CheckpointRef>;
  fork?(
    checkpoint: CheckpointRef,
    options?: ForkRequest,
  ): Promise<AgentEnvironment>;
  placement?(): Promise<PlacementInfo>;
  refresh?(): Promise<void>;
  destroy?(): Promise<void>;
}

export interface AgentEnvironmentCapabilities {
  profile: AgentProfileCapabilities;
  streaming: {
    live: boolean;
    replay: boolean;
    detach: boolean;
    turnIdempotency: boolean;
  };
  sessions: {
    continue: boolean;
    list: boolean;
    messages: boolean;
  };
  workspace: {
    read: boolean;
    write: boolean;
    exec: boolean;
    git: boolean;
    upload: boolean;
    download: boolean;
  };
  branching: {
    checkpoint: boolean;
    fork: boolean;
  };
  placement: boolean;
  usage: boolean;
  confidential: boolean;
  /** Present only when {@link AgentEnvironmentProvider.exactProcess} is implemented. */
  exactProcess?: {
    egress: readonly AgentExactProcessEgressMode[];
  };
}

export interface CreateAgentEnvironmentInput {
  profile: AgentProfileRef;
  /** Agent backend inside the provider, for example "opencode" or "codex". */
  backend?: string;
  workspace?: WorkspaceRequest;
  resources?: ResourceRequest;
  env?: Record<string, string>;
  secrets?: string[] | Record<string, string>;
  metadata?: Record<string, unknown>;
  name?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
  providerOptions?: Record<string, unknown>;
}

export interface AgentEnvironmentProvider {
  readonly name: string;
  readonly exactProcess?: AgentExactProcessProvider;
  capabilities():
    | AgentEnvironmentCapabilities
    | Promise<AgentEnvironmentCapabilities>;
  validateProfile?(
    profile: AgentProfileRef,
  ): AgentProfileValidationResult | Promise<AgentProfileValidationResult>;
  create(input: CreateAgentEnvironmentInput): Promise<AgentEnvironment>;
  get?(id: string): Promise<AgentEnvironment | null>;
  list?(query?: AgentEnvironmentQuery): Promise<AgentEnvironmentSummary[]>;
}

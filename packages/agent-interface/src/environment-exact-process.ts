import type { AgentCandidateTermination } from "./agent-candidate.js";

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
  status(options?: { signal?: AbortSignal }): Promise<AgentExactProcessStatus>;
  wait(options?: { signal?: AbortSignal }): Promise<AgentCandidateTermination>;
  /** Force-stop the full process tree. Idempotent after the process exits. */
  kill(options?: { signal?: AbortSignal }): Promise<void>;
  /** Each iteration replays buffered UTF-8 stdout, then continues until exit. */
  stdout(options?: { signal?: AbortSignal }): AsyncIterable<string>;
  /** Each iteration replays buffered UTF-8 stderr, then continues until exit. */
  stderr(options?: { signal?: AbortSignal }): AsyncIterable<string>;
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
}

export interface AgentExactProcessManager {
  list(options?: { signal?: AbortSignal }): Promise<AgentExactProcessStatus[]>;
  get(pid: number, options?: { signal?: AbortSignal }): Promise<AgentExactProcess | null>;
  /**
   * The abort signal is checked before and after spawn dispatch.
   * If abort is observed after a process starts, the provider kills its tree
   * before rejecting the spawn operation.
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
  /**
   * Write exact bytes to an absolute path with a POSIX mode from 0 through
   * 07777.
   *
   * The abort signal is checked before and after the write.
   * Once dispatched the write is not cancellable, so an abort may reject after
   * the bytes have landed.
   */
  writeFile(
    path: string,
    bytes: Uint8Array,
    options: { mode: number; signal?: AbortSignal },
  ): Promise<void>;
  /**
   * Read exact bytes, or fail before content is loaded when the file exceeds
   * maxBytes. A file that grows after the size check is still rejected, but
   * only after its content was transferred. Reads have no side effect, so the
   * abort signal may reject at any point.
   */
  readFile(
    path: string,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<Uint8Array>;
  destroy(options?: { signal?: AbortSignal }): Promise<void>;
}

export interface AgentExactProcessEnvironmentQuery {
  /** Every supplied key/value must match persisted environment metadata exactly. */
  metadata?: Record<string, unknown>;
  providerOptions?: Record<string, unknown>;
  /** Abort a paginated lookup before the next remote page or conversion. */
  signal?: AbortSignal;
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
  get(id: string, options?: { signal?: AbortSignal }): Promise<AgentExactProcessEnvironment | null>;
  /** Return every matching exact environment; providers own any native pagination. */
  list(query?: AgentExactProcessEnvironmentQuery, options?: { signal?: AbortSignal }): Promise<AgentExactProcessEnvironment[]>;
}

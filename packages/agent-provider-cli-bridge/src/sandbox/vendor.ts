import type {
  AgentEnvironmentEgressMode,
  AgentEnvironmentStatus,
  ExecRequest,
  ExecResult,
  ResourceRequest,
} from "@tangle-network/agent-interface/environment-provider";

/**
 * What a cloud sandbox must expose so a CLI Bridge can run inside it.
 *
 * A vendor adapter is only this: create the sandbox from the box image, run
 * commands in it, expose the Bridge port, report status, destroy it. Profile
 * materialization, turns, events, usage, cancellation and refusals all belong
 * to the Bridge and to {@link createBridgeSandboxProvider}.
 */
export interface BridgeSandbox {
  /** The vendor's own sandbox id. It becomes `AgentEnvironment.id`. */
  readonly id: string;
  readonly region?: string;
  /**
   * Run a command to completion as the box user.
   *
   * A non-zero exit is a result, never a throw. `signal` and `timeoutMs` end
   * the remote command itself, not only the client call.
   */
  exec(command: string, options?: ExecRequest): Promise<ExecResult>;
  /**
   * Start a process that outlives this call, with `env` set on that process
   * only. The Bridge runs this way, so its credentials never enter the sandbox
   * default environment or any command line.
   */
  spawn(command: string, options: { cwd?: string; env: Record<string, string> }): Promise<void>;
  /** Exact bytes written by `write`; a relative path resolves against the workspace directory. */
  read(path: string, options?: { signal?: AbortSignal }): Promise<string>;
  /** Creates parent directories. */
  write(path: string, content: string, options?: { signal?: AbortSignal }): Promise<void>;
  /** The URL that reaches `port` inside the sandbox, plus any headers the vendor's gateway requires. */
  endpoint(port: number, options?: { signal?: AbortSignal }): Promise<{ url: string; headers?: Record<string, string> }>;
  /** The vendor's current lifecycle state; `stopped` or `expired` after destroy or expiry. */
  status(options?: { signal?: AbortSignal }): Promise<AgentEnvironmentStatus>;
  /** Delete the sandbox. Resolves when it is already gone. */
  destroy(options?: { signal?: AbortSignal }): Promise<void>;
}

export interface BridgeSandboxCreateRequest {
  name?: string;
  /** Tags the vendor stores with the sandbox, string values only. Always carries the run tag. */
  metadata: Record<string, string>;
  /** Caller environment for the sandbox's default exec environment. */
  env: Record<string, string>;
  /** Finite lifetime the vendor enforces; longer than any turn the caller may run. */
  lifetimeMs: number;
  /** Vendor template, snapshot or image the caller chose; absent selects the published box image. */
  environment?: string;
  image?: string;
  resources?: ResourceRequest;
  egress?: { mode: AgentEnvironmentEgressMode; allowDomains: readonly string[] };
  /** Aborting must cancel the vendor create and destroy a sandbox that arrives late. */
  signal?: AbortSignal;
}

export interface BridgeSandboxSummary {
  id: string;
  status: AgentEnvironmentStatus;
  name?: string;
  metadata: Record<string, string>;
}

/** Create-input fields a vendor honors beyond the always-honored ones. Everything else is refused. */
export interface BridgeVendorSupport {
  /** `workspace.environment` selects a vendor template or snapshot. */
  environment: boolean;
  /** `workspace.image` selects a vendor image. */
  image: boolean;
  resources: boolean;
  /** Egress modes the vendor enforces; absent modes are refused. */
  egress: readonly AgentEnvironmentEgressMode[];
}

export interface BridgeSandboxVendor {
  /** Provider name reported on every environment, for example `e2b`. */
  readonly name: string;
  readonly support: BridgeVendorSupport;
  create(request: BridgeSandboxCreateRequest): Promise<BridgeSandbox>;
  /** `null` only when the vendor definitively reports no such sandbox; transport failures throw. */
  connect(id: string, options?: { signal?: AbortSignal }): Promise<BridgeSandbox | null>;
  /** Sandboxes whose tags contain every entry of `metadata`, with their true status. */
  list(query: { name?: string; metadata?: Record<string, string> }, options?: { signal?: AbortSignal }): Promise<BridgeSandboxSummary[]>;
}

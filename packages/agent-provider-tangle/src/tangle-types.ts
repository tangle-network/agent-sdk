import type {
  BackendType,
  CreateSandboxOptions,
  ExecResult as SandboxExecResult,
  PromptOptions,
  PromptResult,
  SandboxEvent,
} from "@tangle-network/sandbox";
import type {
  AgentRunCancellationAcknowledgement,
  AgentRunCancellationRequest,
  InputPart,
} from "@tangle-network/agent-interface";
import type {
  AgentEnvironmentCapabilities,
  AgentEnvironmentProvider,
  CreateAgentEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";

export interface TangleExactProcessOptions {
  teamId?: string;
}

export interface SandboxClientLike {
  create(
    options?: CreateSandboxOptions,
    requestOptions?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<SandboxInstanceLike>;
  /**
   * SDK HttpClient transport, present on `Sandbox` and `TangleSandboxClient`.
   * Retained control requires it: the provider mints a lazy probe instance
   * over this surface to read the linked SDK's method surface before any
   * sandbox exists. An object-spread wrapper (`{ ...client }`) drops class
   * prototype methods including this one, so such a wrapper never claims
   * retained control; pass the SDK client itself or delegate its methods.
   */
  fetch?(
    path: string,
    options?: RequestInit,
    fetchOptions?: { timeoutMs?: number },
  ): Promise<Response>;
  get?(id: string, requestOptions?: { signal?: AbortSignal }): Promise<SandboxInstanceLike | null>;
  list?(options?: {
    scope?: string;
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
  }): Promise<SandboxInstanceLike[]>;
  describePlacement?(box: SandboxInstanceLike): unknown;
}

/**
 * The `GET /capabilities` document as this adapter reads it: what the DEPLOYED
 * sidecar image compiled in, not which methods the linked SDK class carries.
 *
 * Every capability flag this shape declares gates a claim the adapter makes,
 * and the wire document's other flags are absent here because the adapter does
 * not act on them yet. Every field is optional, and the document's own
 * convention is that a missing flag means "unknown to that image", never
 * false. The linked SDK parses a v1 wire body strictly, but this adapter reads
 * any `SandboxInstanceLike`, so it never assumes a flag was validated: an
 * absent field reaches the claim as unknown instead of being coerced. The
 * SDK's `SandboxRuntimeCapabilities` is assignable to this shape;
 * `deployment-capabilities.test.ts` pins that against the published type.
 */
export interface SandboxRuntimeCapabilityDocument {
  schema?: number;
  agentInterface?: string;
  sidecarVersion?: string;
  image?: string;
  dispatch?: {
    /** Run requests accept a caller-supplied exact `runControlRef`. */
    runControlRef?: boolean;
    /** Admission echoes the executionId the request named. */
    executionIdOnAdmission?: boolean;
  };
  cancel?: {
    /** Cancellation accepts the canonical digest-bound request. */
    canonicalRunCancellation?: boolean;
    /** Cancellation binds to the run's request digest. */
    digestBound?: boolean;
    /** Replaying an operation id returns the stored acknowledgement. */
    idempotent?: boolean;
  };
  runs?: {
    /** Status and results select one execution of a session. */
    executionScopedStatus?: boolean;
    /** Buffered run events replay by execution. */
    eventReplay?: boolean;
  };
}

export interface SandboxProcessStatusLike {
  pid: number;
  running: boolean;
  exitCode: number;
  exitSignal?: string;
}

export interface SandboxProcessLike {
  readonly pid: number;
  status(): Promise<SandboxProcessStatusLike>;
  wait(): Promise<number>;
  kill(signal?: "SIGKILL", options?: { tree?: boolean }): Promise<void>;
  stdout(): AsyncIterable<string>;
  stderr(): AsyncIterable<string>;
}

export interface SandboxProcessManagerLike {
  list(): Promise<SandboxProcessStatusLike[]>;
  get(pid: number): Promise<SandboxProcessLike | null>;
  spawnExact(
    executable: string,
    args: readonly string[],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      inheritEnv?: boolean;
      stdin?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<SandboxProcessLike>;
}

export interface SandboxInstanceLike {
  id: string;
  name?: string;
  status?: unknown;
  metadata?: Record<string, unknown>;
  streamPrompt(message: string | InputPart[], options?: PromptOptions): AsyncIterable<SandboxEvent>;
  prompt?(message: string | InputPart[], options?: PromptOptions): Promise<PromptResult>;
  dispatchPrompt?(message: string | InputPart[], options?: PromptOptions): Promise<unknown>;
  session?(id: string, options?: { signal?: AbortSignal }): SandboxSessionLike;
  read?(path: string, options?: { sessionId?: string; signal?: AbortSignal }): Promise<string>;
  write?(path: string, content: string, options?: { sessionId?: string; signal?: AbortSignal }): Promise<unknown>;
  exec?(command: string, options?: unknown): Promise<SandboxExecResult>;
  fs?: {
    supportsWriteMode?: true;
    stat(path: string): Promise<{ size: number; isFile: boolean }>;
    readBatch(
      paths: string[],
      options?: { encoding?: "utf8" | "base64" },
    ): Promise<{
      files: Array<{
        path: string;
        content: string;
        encoding: "utf8" | "base64";
        size: number;
      }>;
      errors: Array<{ path: string; error: string; code?: string }>;
    }>;
    write(
      path: string,
      content: string,
      options: { encoding: "base64"; mode: number },
    ): Promise<unknown>;
  };
  process?: SandboxProcessManagerLike;
  /**
   * Capability discovery against the deployment behind this sandbox. Absent
   * on a Sandbox SDK older than 0.22.0, which is why every call site feature-
   * detects it: an older SDK cannot read deployment truth, so the adapter
   * claims no retained control rather than trusting its own method surface.
   * Resolves to null when the deployment cannot disclose a document this SDK
   * reads; a malformed document throws.
   */
  capabilities?(): Promise<SandboxRuntimeCapabilityDocument | null>;
  refresh?(options?: { signal?: AbortSignal }): Promise<void>;
  delete?(options?: { signal?: AbortSignal }): Promise<void>;
}

export interface SandboxSessionLike {
  readonly id: string;
  status(options?: { signal?: AbortSignal }): Promise<unknown | null>;
  events(options?: {
    since?: string;
    executionId?: string;
    signal?: AbortSignal;
  }): AsyncIterable<SandboxEvent>;
  result(options?: { executionId?: string; signal?: AbortSignal }): Promise<PromptResult>;
  prompt(message: string | InputPart[], options?: PromptOptions): Promise<PromptResult>;
  interrupt(options?: { executionId?: string; signal?: AbortSignal }): Promise<{ cancelled: boolean }>;
  cancelRun?(
    request: AgentRunCancellationRequest,
    options?: { signal?: AbortSignal },
  ): Promise<AgentRunCancellationAcknowledgement>;
}

export interface TangleProviderOptions {
  client: SandboxClientLike;
  name?: string;
  defaultBackend?: BackendType;
  capabilities?: AgentEnvironmentCapabilities | (() => AgentEnvironmentCapabilities | Promise<AgentEnvironmentCapabilities>);
  validateProfile?: AgentEnvironmentProvider["validateProfile"];
  mapCreateInput?: (input: CreateAgentEnvironmentInput) => CreateSandboxOptions;
  exactProcess?: TangleExactProcessOptions;
}

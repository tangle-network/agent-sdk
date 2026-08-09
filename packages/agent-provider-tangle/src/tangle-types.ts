import type {
  BackendType,
  CreateSandboxOptions,
  ExecResult as SandboxExecResult,
  PromptOptions,
  PromptResult,
  SandboxEvent,
} from "@tangle-network/sandbox";
import type { InputPart } from "@tangle-network/agent-interface";
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
  get?(id: string, requestOptions?: { signal?: AbortSignal }): Promise<SandboxInstanceLike | null>;
  list?(options?: {
    scope?: string;
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
  }): Promise<SandboxInstanceLike[]>;
  describePlacement?(box: SandboxInstanceLike): unknown;
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
  checkpoint?(options?: { signal?: AbortSignal } & Record<string, unknown>): Promise<unknown>;
  fork?(checkpointId: string, options?: { signal?: AbortSignal } & Record<string, unknown>): Promise<SandboxInstanceLike>;
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

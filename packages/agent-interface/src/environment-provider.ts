import type {
  AgentProfile,
  AgentProfileCapabilities,
  AgentProfileValidationResult,
} from "./agent-profile.js";
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

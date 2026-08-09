import type {
  AgentExactRunControlRef,
  AgentWorkspaceBranching,
  ContextTransferResult,
  ContextTransferRequest,
  InteractionAcknowledgement,
  InteractionRequest,
  InteractionResponseCommand,
} from "@tangle-network/agent-interface";
import type {
  NativeContextBoundaryProof,
  NativeContextContinuationAcknowledgement,
  NativeContextContinuationRequest,
  PortableContextPlanRequest,
  PortableContextPlanResult,
  WorkspaceCheckpointRequest,
  WorkspaceCheckpointRef,
  WorkspaceForkRequest,
} from "@tangle-network/agent-interface";
import type {
  AgentEnvironmentCapabilities,
  AgentEnvironmentProvider,
  AgentExactProcessLaunch,
  AgentSession,
  AgentSessionRef,
  AgentTurnInput,
  CreateAgentEnvironmentInput,
  CreateAgentExactProcessEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";


export interface ProviderConformanceOptions {
  name: string;
  createProvider(): AgentEnvironmentProvider | Promise<AgentEnvironmentProvider>;
  createInput?: Partial<CreateAgentEnvironmentInput>;
  prompt?: string;
  requireUsage?: boolean;
  requireDispatch?: boolean;
}

export interface ProviderConformanceReport {
  provider: string;
  environmentId: string;
  capabilities: AgentEnvironmentCapabilities;
  events: number;
  checked: string[];
}

export interface ExactProcessProviderLifecycleOptions {
  createProvider(): AgentEnvironmentProvider | Promise<AgentEnvironmentProvider>;
  createInput: CreateAgentExactProcessEnvironmentInput;
  launch: AgentExactProcessLaunch;
  expectedStdout: string;
  expectedStderr: string;
  /** Overall wall-clock bound for one lifecycle check. Defaults to 30 seconds. */
  timeoutMs?: number;
}

export interface ExactProcessProviderLifecycleReport {
  provider: string;
  environmentId: string;
  pid: number;
  checked: string[];
}

export interface InteractionResponseConformanceOptions {
  name: string;
  request: InteractionRequest;
  command: InteractionResponseCommand;
  /** Prepared interaction states needed to exercise non-happy-path outcomes. */
  statusCases: readonly InteractionResponseStatusCase[];
  respond(
    command: InteractionResponseCommand,
  ): Promise<InteractionAcknowledgement>;
}

export interface InteractionResponseStatusCase {
  request: InteractionRequest;
  command: InteractionResponseCommand;
  expectedStatus: "expired" | "cancelled" | "transport_failure";
}

export interface InteractionResponseConformanceReport {
  name: string;
  checked: string[];
}

export interface PortableContextConformanceCounters {
  plans: number;
  transfers: number;
  freshSessions: number;
  nativeContinuations: number;
}

export interface PortableContextConformanceOptions {
  name: string;
  request: PortableContextPlanRequest;
  /** A request the implementation must reject as over its exact token budget. */
  rejectionRequest: PortableContextPlanRequest;
  run: AgentExactRunControlRef;
  acceptedAt: string;
  plan(request: PortableContextPlanRequest): Promise<PortableContextPlanResult>;
  transfer(request: ContextTransferRequest): Promise<ContextTransferResult>;
  boundary(run: AgentExactRunControlRef): Promise<NativeContextBoundaryProof | null>;
  continueNative(
    request: NativeContextContinuationRequest,
  ): Promise<NativeContextContinuationAcknowledgement>;
  counters(): PortableContextConformanceCounters | Promise<PortableContextConformanceCounters>;
}

export interface PortableContextConformanceReport {
  name: string;
  planDigest: string;
  contextDigest: string;
  checked: string[];
}

export interface WorkspaceBranchingConformanceOptions {
  name: string;
  operations: AgentWorkspaceBranching;
  checkpointRequest: WorkspaceCheckpointRequest;
  forkRequest(
    checkpoint: WorkspaceCheckpointRef,
  ): WorkspaceForkRequest;
}

export interface WorkspaceBranchingConformanceReport {
  name: string;
  checkpointId: string;
  environmentId: string;
  checked: string[];
}

export interface SessionReplayConformanceOptions {
  name: string;
  createProvider(): AgentEnvironmentProvider | Promise<AgentEnvironmentProvider>;
  createInput?: Partial<CreateAgentEnvironmentInput>;
  turn: AgentTurnInput;
  /** Recreate the session through a new client/environment after dispatch. */
  reconnect(
    reference: AgentSessionRef,
  ): AgentSession | Promise<AgentSession>;
}

export interface SessionReplayConformanceReport {
  name: string;
  sessionId: string;
  eventIds: string[];
  checked: string[];
}

export class ProviderConformanceError extends Error {
  constructor(
    message: string,
    readonly checked: string[],
  ) {
    super(message);
    this.name = "ProviderConformanceError";
  }
}

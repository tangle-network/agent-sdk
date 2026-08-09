import type {
  InteractionAcknowledgement,
  InteractionResponse,
  InteractionResponseCommand,
} from "./interaction.js";
import type {
  AgentExecutionInput,
  AgentExecutionResult,
} from "./execution-types.js";
import type { BackendMessage, GetMessagesOptions } from "./backend-message.js";
import type { SdkHostServices } from "./host-services.js";
import type {
  BackendCapabilities,
  ProviderConfig,
} from "./provider-config.js";
import type {
  BackendArtifact,
  BackendListOptions,
  McpConfig,
  McpStatusResponse,
} from "./mcp.js";
import type { StreamEvent } from "./stream-events.js";

export interface SdkProviderAdapter {
  readonly provider: string;
  getCapabilities(): BackendCapabilities;
  initialize(config: ProviderConfig): Promise<void>;
  createSession?(options?: { workspaceRoot?: string }): Promise<string>;
  forkSession?(options: {
    sessionId: string;
    messageId?: string;
    workspaceRoot?: string;
  }): Promise<string>;
  execute(
    input: AgentExecutionInput,
    services: SdkHostServices,
    onEvent?: (event: StreamEvent) => void,
  ): Promise<AgentExecutionResult>;
  shutdown(): Promise<void>;
  healthCheck(): Promise<boolean>;
  getMessages?(options: GetMessagesOptions): Promise<BackendMessage[]>;
  addMcp?(name: string, config: McpConfig): Promise<void>;
  getMcpStatus?(): Promise<McpStatusResponse>;
  ensureMcps?(required: Record<string, McpConfig>): Promise<void>;
  updateConfig?(config: unknown): Promise<unknown>;
  getAccount?(): Promise<unknown>;
  listModels?(): Promise<unknown>;
  listRepositories?(): Promise<unknown>;
  listAgents?(options?: BackendListOptions): Promise<unknown>;
  getAgent?(agentId: string): Promise<unknown>;
  archiveAgent?(agentId: string): Promise<void>;
  unarchiveAgent?(agentId: string): Promise<void>;
  deleteAgent?(agentId: string): Promise<void>;
  listRuns?(agentId: string, options?: BackendListOptions): Promise<unknown>;
  getRun?(runId: string, agentId?: string): Promise<unknown>;
  listAgentMessages?(
    agentId: string,
    options?: BackendListOptions,
  ): Promise<unknown>;
  listArtifacts?(sessionId: string): Promise<BackendArtifact[]>;
  downloadArtifact?(sessionId: string, path: string): Promise<Uint8Array>;
  respondToInteraction?(response: InteractionResponse): Promise<void>;
  respondToInteractionCommand?(
    command: InteractionResponseCommand,
    options?: { signal?: AbortSignal },
  ): Promise<InteractionAcknowledgement>;
}

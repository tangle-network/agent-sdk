import type {
  AgentEnvironmentCapabilities,
  AgentEnvironmentEvent,
  AgentTurnInput,
  CreateAgentEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";

export interface CliBridgeProviderOptions {
  baseUrl: string;
  bearerToken?: string;
  defaultModel?: string;
  defaultMode?: "byob" | "hosted-safe" | "hosted-sandboxed";
  defaultExecution?:
    | { kind: "host" }
    | {
        kind: "sandbox";
        repoUrl?: string;
        gitRef?: string;
        capability?: string;
        ttlSeconds?: number;
      };
  /** Maximum wait for response headers. Defaults to no timeout. */
  headersTimeoutMs?: number;
  /** Maximum idle time between response body chunks. Defaults to no timeout. */
  bodyTimeoutMs?: number;
  /** Maximum wait for cli-bridge to confirm cancellation. Defaults to 30 seconds. */
  cancelWaitMs?: number;
  fetch?: typeof fetch;
  name?: string;
  capabilities?: AgentEnvironmentCapabilities;
}

export interface CliBridgeRun {
  readonly id: string;
  readonly sessionId?: string;
  readonly turnId: string;
  readonly requestBody: string;
  readonly readers: Set<AbortController>;
  sessionPrevious?: CliBridgeRun;
  accepted?: boolean;
  requestDigest?: string;
  cancellation?: Promise<CliBridgeRunSnapshot>;
  settled?: boolean;
}

export interface CliBridgeSessionState {
  readonly id: string;
  current: CliBridgeRun;
}

export interface CliBridgeRunSnapshot {
  readonly id: string;
  readonly status: "running" | "done" | "error" | "cancelled";
  readonly terminal: boolean;
}

export interface PreparedCliBridgeRun {
  readonly run: CliBridgeRun;
  readonly turn: AgentTurnInput;
}

export interface CliBridgeTransport {
  fetch(input: string, init: CliBridgeRequest): Promise<CliBridgeResponse>;
  close(): Promise<void>;
}

export interface CliBridgeRequest {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface CliBridgeResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: AsyncIterable<Uint8Array> | null;
  readonly headers: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
}

export interface CreateCliBridgeSessionArgs {
  readonly id: string;
  readonly providerName: string;
  readonly options: CliBridgeProviderOptions;
  readonly environmentInput: CreateAgentEnvironmentInput;
  readonly environmentId: string;
  readonly transport: CliBridgeTransport;
  readonly runs: Map<string, CliBridgeRun>;
  readonly sessions: Map<string, CliBridgeSessionState>;
  readonly readers: Set<AbortController>;
  readonly isDestroyed: () => boolean;
}

export interface CliBridgeSseFrame {
  readonly data: string;
  readonly id?: string;
}

export interface CliBridgeEventSourceOptions {
  since?: string;
  signal?: AbortSignal;
}

export type CliBridgeEvent = AgentEnvironmentEvent;

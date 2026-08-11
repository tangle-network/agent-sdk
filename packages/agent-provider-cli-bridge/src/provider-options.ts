import type { AgentEnvironmentCapabilities } from "@tangle-network/agent-interface/environment-provider";

export interface CliBridgeProviderOptions {
  baseUrl: string;
  bearerToken?: string;
  defaultModel?: string;
  defaultMode?: "byob" | "hosted-safe" | "hosted-sandboxed";
  defaultExecution?: { kind: "host" } | {
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

export function assertCliBridgeProviderOptions(options: CliBridgeProviderOptions): void {
  assertTimeout(options.headersTimeoutMs, "headersTimeoutMs");
  assertTimeout(options.bodyTimeoutMs, "bodyTimeoutMs");
  assertTimeout(options.cancelWaitMs, "cancelWaitMs");
}

function assertTimeout(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`createCliBridgeProvider ${name} must be a non-negative integer`);
  }
}

import type { AgentEnvironmentCapabilities } from "@tangle-network/agent-interface/environment-provider";

export const MAX_CLI_BRIDGE_TIMEOUT_MS = 2_147_483_647;

/**
 * The execution object accepted by cli-bridge's request wire contract.
 *
 * The provider forwards this object unchanged as `execution`; cli-bridge owns
 * validation, confinement resolution, and execution placement.
 */
export type CliBridgeExecution =
  | {
      kind: "host";
      jail?: {
        mode?: "off" | "write-jail" | "fs-jail";
        root?: string;
      };
      netJail?: {
        mode?: "off" | "net-jail";
        allow?: string[];
      };
      timeoutMs?: number;
    }
  | {
      kind: "sandbox";
      repoUrl?: string;
      gitRef?: string;
      capability?: string;
      ttlSeconds?: number;
      netJail?: {
        mode?: "off" | "net-jail";
        allow?: string[];
      };
      timeoutMs?: number;
    };

export interface CliBridgeProviderOptions {
  baseUrl: string;
  bearerToken?: string;
  defaultModel?: string;
  defaultMode?: "byob" | "hosted-safe" | "hosted-sandboxed";
  defaultExecution?: CliBridgeExecution;
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
  if (value !== undefined && value > MAX_CLI_BRIDGE_TIMEOUT_MS) {
    throw new Error(
      `createCliBridgeProvider ${name} must be no greater than ${MAX_CLI_BRIDGE_TIMEOUT_MS}`,
    );
  }
}

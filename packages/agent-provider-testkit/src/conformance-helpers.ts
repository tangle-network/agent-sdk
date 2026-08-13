import { isDeepStrictEqual } from "node:util";
import { AgentEnvironmentCapabilitiesSchema } from "@tangle-network/agent-interface/environment-provider";
import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
  AgentEnvironmentEvent,
} from "@tangle-network/agent-interface/environment-provider";
import { ProviderConformanceError } from "./conformance-types.js";

/**
 * The capability document that describes one environment.
 *
 * A capability the connected deployment decides is environment-scoped, so the
 * provider document cannot state it: one provider reaches deployments of
 * different ages. An environment that publishes its own document answers for
 * itself, and every exposure check binds to that answer. An environment that
 * publishes none is fully described by the provider document.
 */
export function environmentCapabilityDocument(
  environment: AgentEnvironment,
  providerCapabilities: AgentEnvironmentCapabilities,
): AgentEnvironmentCapabilities {
  if (environment.capabilities === undefined) return providerCapabilities;
  return AgentEnvironmentCapabilitiesSchema.parse(environment.capabilities);
}

export async function checkWorkspace(
  environment: AgentEnvironment,
  capabilities: AgentEnvironmentCapabilities,
  checked: string[],
): Promise<void> {
  if (capabilities.workspace.write) {
    assert(typeof environment.write === "function", "workspace.write requires write()", checked);
    await environment.write?.("agent-provider-testkit.txt", "ok");
    checked.push("workspace-write");
  }

  if (capabilities.workspace.read) {
    assert(typeof environment.read === "function", "workspace.read requires read()", checked);
    await environment.read?.("agent-provider-testkit.txt");
    checked.push("workspace-read");
  }

  if (capabilities.workspace.exec) {
    assert(typeof environment.exec === "function", "workspace.exec requires exec()", checked);
    const result = await environment.exec?.("echo ok");
    assert(result?.exitCode !== undefined, "exec() must return an exit code", checked);
    checked.push("workspace-exec");
  }
}

export function checkCapabilityExposure(
  environment: AgentEnvironment,
  capabilities: AgentEnvironmentCapabilities,
  checked: string[],
): void {
  const checkMethod = (
    method: keyof AgentEnvironment,
    enabled: boolean,
    capability: string,
  ) => {
    assert(
      (typeof environment[method] === "function") === enabled,
      enabled
        ? `${capability} requires ${String(method)}()`
        : `${capability} is disabled but ${String(method)}() is exposed`,
      checked,
    );
  };

  checkMethod("dispatch", capabilities.streaming.detach, "streaming.detach");
  checkMethod(
    "session",
    capabilities.streaming.detach ||
      capabilities.streaming.replay ||
      capabilities.sessions.continue,
    "session control",
  );
  checkMethod(
    "respondToInteraction",
    capabilities.interactions !== undefined,
    "interactions",
  );
  checkMethod("read", capabilities.workspace.read, "workspace.read");
  checkMethod("write", capabilities.workspace.write, "workspace.write");
  checkMethod("exec", capabilities.workspace.exec, "workspace.exec");
  checkMethod(
    "checkpoint",
    capabilities.branching.checkpoint,
    "branching.checkpoint",
  );
  checkMethod("fork", capabilities.branching.fork, "branching.fork");
  checkMethod("placement", capabilities.placement, "placement");

  const durableBranching =
    capabilities.branching.retrySafe === true &&
    capabilities.branching.lookup === true &&
    capabilities.branching.cleanup === true;
  assert(
    (environment.workspaceBranching !== undefined) === durableBranching,
    durableBranching
      ? "durable branching requires workspaceBranching operations"
      : "durable branching is disabled but workspaceBranching is exposed",
    checked,
  );
  checked.push("capability-exposure");
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of iterable) out.push(value);
  return out;
}

export function deepEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

export async function withEnvironmentCleanup<T>(
  environment: AgentEnvironment,
  checked: string[],
  operation: () => Promise<T>,
  recordCleanup = false,
): Promise<T> {
  let outcome:
    | { ok: true; value: T }
    | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await operation() };
  } catch (error) {
    outcome = { ok: false, error };
  }

  let cleanupError: unknown;
  try {
    await environment.destroy?.();
    if (outcome.ok && recordCleanup) checked.push("destroy");
  } catch (error) {
    cleanupError = error;
  }

  if (!outcome.ok) {
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [outcome.error, cleanupError],
        "provider conformance and environment cleanup failed",
      );
    }
    throw outcome.error;
  }
  if (cleanupError !== undefined) throw cleanupError;
  return outcome.value;
}

export function assert(value: unknown, message: string, checked: string[]): asserts value {
  if (!value) throw new ProviderConformanceError(message, checked);
}

export function isTerminalEvent(event: AgentEnvironmentEvent): boolean {
  if (event.type === "result" || event.type === "done" || event.type === "final") return true;
  if (event.type.endsWith(".completed") || event.type.endsWith(".failed")) return true;
  if (event.type === "status") {
    return event.data.status === "completed" || event.data.status === "failed" || event.data.status === "cancelled";
  }
  return false;
}

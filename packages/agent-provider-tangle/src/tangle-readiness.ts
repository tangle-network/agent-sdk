import { awaitWithSignal } from "./tangle-contract-safety.js";
import { statusFromUnknown } from "./tangle-environment-values.js";
import type { SandboxClientLike, SandboxInstanceLike } from "./tangle-types.js";

/**
 * How long `create()` waits for a new sandbox to reach `running`.
 *
 * The value is the Sandbox SDK's own wait default, so the adapter states no
 * second deadline that disagrees with the platform's.
 */
export const DEFAULT_TANGLE_READY_TIMEOUT_MS = 120_000;

/**
 * Hold `create()` until the sandbox can accept a turn.
 *
 * The gap this closes is narrow and specific. `client.create()` waits by
 * itself only when the create response reports `pending` or `provisioning`.
 * A response that already reports `running` skips that wait, and `running`
 * alone is not usable: the SDK's own `waitFor` treats the target as reached
 * only when `filesystemIncarnationReadiness` is `ready`, because the box's
 * filesystem is still being built until then. An environment composed before
 * that is an environment that cannot accept a turn.
 *
 * The platform owns the wait, and this adapter runs no status loop of its own.
 * `waitFor` on the created instance is preferred because it refreshes that
 * instance in place, which keeps the create receipt and gains the runtime
 * connection the environment reads.
 */
export async function awaitSandboxRunning(
  box: SandboxInstanceLike,
  client: SandboxClientLike,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<void> {
  const { timeoutMs, signal } = options;
  signal?.throwIfAborted();
  const waitOptions = {
    timeoutMs,
    ...(signal ? { signal } : {}),
  };
  const wait = waitForRunning(box, client, waitOptions);
  if (wait === undefined) {
    // A client that offers no wait cannot prove readiness, so the sandbox it
    // returned has to prove it by itself or the create call fails.
    assertRunning(box, box.status, "the linked client provides neither instance waitFor() nor client waitForRunning()");
    return;
  }
  let observed: unknown;
  try {
    observed = await awaitWithSignal(wait(), signal);
  } catch (error) {
    // An abort is the caller's own outcome and keeps its identity.
    if (signal?.aborted) throw error;
    throw new Error(
      `Tangle sandbox ${box.id} did not reach running: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  // A client whose wait resolves over a sandbox that is not running is refused here.
  assertRunning(box, observed, "its wait resolved without reaching running");
}

function assertRunning(
  box: SandboxInstanceLike,
  status: unknown,
  reason: string,
): void {
  const observed = statusFromUnknown(status);
  if (observed === "running") return;
  throw new Error(
    `Tangle create cannot return sandbox ${box.id}: it reports ${observed} and ${reason}`,
  );
}

function waitForRunning(
  box: SandboxInstanceLike,
  client: SandboxClientLike,
  options: { timeoutMs: number; signal?: AbortSignal },
): (() => Promise<unknown>) | undefined {
  const instanceWait = box.waitFor;
  if (instanceWait) {
    return async () => {
      await instanceWait.call(box, "running", options);
      // `waitFor` refreshes this instance in place, so this instance now holds
      // the status the platform answered with.
      return box.status;
    };
  }
  const clientWait = client.waitForRunning;
  if (clientWait) {
    return async () => {
      const ready = await clientWait.call(client, box.id, options);
      // The client-side wait resolves a second instance for the same id. That
      // instance carries the platform's answer; the created instance still
      // holds what it was returned with until it refreshes.
      await box.refresh?.(options.signal);
      return ready?.id === box.id ? ready.status : undefined;
    };
  }
  return undefined;
}

/**
 * The state of a box the Sandbox API no longer serves: "deleted" for a 404,
 * or the "failed"/"deleted" status it reports. Runtime replaces such a box,
 * so reconnect and stop answer not-live instead of throwing. Any other
 * refresh error (5xx, network) is not evidence the box is gone: undefined.
 */
export async function notLiveState(
  box: SandboxInstanceLike,
  signal?: AbortSignal,
): Promise<"failed" | "deleted" | undefined> {
  try {
    await box.refresh?.(signal);
  } catch (error) {
    return (error as { status?: unknown } | null)?.status === 404 ? "deleted" : undefined;
  }
  return box.status === "failed" || box.status === "deleted" ? box.status : undefined;
}

/** Reconnect lookup: null for a box the Sandbox API answers 404, failed or deleted. */
export async function servedSandbox(
  client: SandboxClientLike,
  id: string,
  signal?: AbortSignal,
): Promise<SandboxInstanceLike | null> {
  try {
    const box = await client.get?.(id, signal ? { signal } : undefined);
    return box && box.status !== "failed" && box.status !== "deleted" ? box : null;
  } catch (error) {
    if ((error as { status?: unknown } | null)?.status === 404) return null;
    throw error;
  }
}

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
 * filesystem is still being built until then. So `create()` can return a box
 * that reports `running` while the platform still holds a lifecycle operation
 * on it, and the first turn lands on that lock.
 *
 * Measured against that mechanism, 2026-09-01, discovery-lab#467: one box
 * (`sandbox-97943ce9526d`) came back from `create()`, and the first
 * `environment.stream()` failed 78 seconds later with "A sandbox lifecycle
 * operation is already in progress". That string is the platform's, not the
 * SDK's, and n is 1, so the incarnation window is the mechanism this wait
 * addresses rather than a proven cause. A lifecycle lock held by a genuinely
 * concurrent operation is a different failure, and no client-side wait
 * prevents it.
 *
 * Readiness also decides what the environment can claim. Composing an
 * environment reads the sandbox's deployment capability document once, and a
 * sandbox that is not yet running cannot answer that read, so an environment
 * composed during provisioning claims nothing for the rest of its life.
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
  // A wait that resolves is the platform's answer, and the status it leaves
  // behind is that answer in a readable form. Reading it back costs nothing
  // and refuses a client whose wait resolves over a sandbox that is not
  // running, which is the one way a half-started environment could still
  // reach the caller.
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

import { awaitWithSignal } from "./tangle-contract-safety.js";
import { statusFromUnknown } from "./tangle-environment-values.js";
import type { SandboxClientLike, SandboxInstanceLike } from "./tangle-types.js";

/**
 * How long `create()` waits for a new sandbox to reach `running`.
 *
 * The value is the Sandbox SDK's own `waitFor` default, so the adapter states
 * no second deadline that disagrees with the platform's.
 */
export const DEFAULT_TANGLE_READY_TIMEOUT_MS = 120_000;

/**
 * Hold `create()` until the sandbox can accept a turn.
 *
 * Measured motive: on 2026-09-01 one real box (`sandbox-97943ce9526d`) came
 * back from `create()` while it was still starting, and the first
 * `environment.stream()` failed with "A sandbox lifecycle operation is already
 * in progress". agent-runtime's provider executor calls create and stream back
 * to back with nothing between them, so an unready environment hands the race
 * to every caller and each one writes the same wait.
 *
 * Readiness also decides what the environment can claim. Composing an
 * environment reads the sandbox's deployment capability document once, and a
 * starting sandbox cannot answer that read, so an environment composed during
 * provisioning claims nothing for the rest of its life.
 *
 * The platform owns the wait. This adapter asks through the SDK and runs no
 * status loop of its own: `waitFor` on the created instance is preferred
 * because it refreshes that instance in place, which keeps the create receipt
 * and gains the runtime connection the environment reads.
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
    const status = statusFromUnknown(box.status);
    // A sandbox that reports no status gives the adapter no evidence of a
    // lifecycle in progress, and the adapter does not invent one. A sandbox
    // that reports `pending` or `provisioning` is starting, and returning it
    // would be returning the measured defect.
    if (status === "pending" || status === "provisioning") {
      throw new Error(
        `Tangle create cannot return a sandbox that is still ${status}: the linked client provides neither instance waitFor() nor client waitForRunning()`,
      );
    }
    return;
  }
  try {
    await awaitWithSignal(wait(), signal);
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
}

function waitForRunning(
  box: SandboxInstanceLike,
  client: SandboxClientLike,
  options: { timeoutMs: number; signal?: AbortSignal },
): (() => Promise<void>) | undefined {
  const instanceWait = box.waitFor;
  if (instanceWait) {
    return async () => {
      await instanceWait.call(box, "running", options);
    };
  }
  const clientWait = client.waitForRunning;
  if (clientWait) {
    return async () => {
      await clientWait.call(client, box.id, options);
      // The client-side wait resolves a second instance for the same id, so the
      // created instance still holds the status and connection it was returned
      // with until it refreshes.
      await box.refresh?.(options.signal);
    };
  }
  return undefined;
}

import type {
  SandboxInstanceLike,
  SandboxRuntimeCapabilityDocument,
} from "./tangle-types.js";
import { statusFromUnknown } from "./tangle-environment-values.js";
import { awaitWithSignal } from "./tangle-contract-safety.js";

/**
 * What the connected deployment reports about the operations this adapter
 * builds on top of a run.
 *
 * `measured: false` belongs to the client stage alone: no sandbox exists
 * there, so no deployment can answer, and the adapter's own method surface
 * stands as the upper bound. Every stage that holds a concrete sandbox
 * reports `measured: true` with explicit flags, and an unreadable document
 * lands there as false — claim nothing rather than assume.
 */
export type DeploymentCapabilitySupport =
  | { readonly measured: false }
  | {
      readonly measured: true;
      /** Run requests carry the caller's exact `runControlRef`. */
      readonly exactRunControlRef: boolean;
      /** Cancellation is canonical, digest-bound, and idempotent. */
      readonly canonicalCancellation: boolean;
    };

/** The client stage, where no sandbox exists to interrogate. */
export const UNMEASURED_DEPLOYMENT: DeploymentCapabilitySupport = {
  measured: false,
};

/**
 * Read the deployment facts out of a capability document.
 *
 * A missing flag is unknown, and unknown is never a claim, so every flag must
 * be present and true to count. Canonical cancellation needs all three of its
 * flags together: a cancellation that is not bound to the run's request
 * digest, or not idempotent under replay, cannot carry retained control.
 */
export function deploymentCapabilitySupport(
  document: SandboxRuntimeCapabilityDocument | null | undefined,
): DeploymentCapabilitySupport {
  if (!document || typeof document !== "object") {
    return { measured: true, exactRunControlRef: false, canonicalCancellation: false };
  }
  return {
    measured: true,
    exactRunControlRef: document.dispatch?.runControlRef === true,
    canonicalCancellation:
      document.cancel?.canonicalRunCancellation === true &&
      document.cancel?.digestBound === true &&
      document.cancel?.idempotent === true,
  };
}

/**
 * Establish the deployment facts for one sandbox through capability
 * discovery.
 *
 * Three inputs resolve to "nothing claimed" without a request: a Sandbox SDK
 * older than 0.22.0, which carries no `capabilities` method; a sandbox that
 * is not running, whose capability route can only answer with a state error;
 * and a `null` document, which is a deployment predating capability discovery
 * or one serving a schema this SDK cannot read.
 *
 * Every other failure propagates. A malformed document means the deployment
 * is defective, and swallowing that would hand back a silently degraded
 * environment instead of the defect.
 */
export async function readDeploymentCapabilitySupport(
  box: SandboxInstanceLike,
  options?: { signal?: AbortSignal },
): Promise<DeploymentCapabilitySupport> {
  if (typeof box.capabilities !== "function") {
    return deploymentCapabilitySupport(null);
  }
  if (statusFromUnknown(box.status) !== "running") {
    return deploymentCapabilitySupport(null);
  }
  options?.signal?.throwIfAborted();
  const document = await awaitWithSignal(box.capabilities(), options?.signal);
  options?.signal?.throwIfAborted();
  return deploymentCapabilitySupport(document);
}

/** Whether the deployment backs a detached run carrying an exact reference. */
export function deploymentBacksExactDispatch(
  deployment: DeploymentCapabilitySupport,
): boolean {
  return !deployment.measured || deployment.exactRunControlRef;
}

/** Whether the deployment backs the complete retained-control identity set. */
export function deploymentBacksRetainedControl(
  deployment: DeploymentCapabilitySupport,
): boolean {
  return (
    !deployment.measured ||
    (deployment.exactRunControlRef && deployment.canonicalCancellation)
  );
}

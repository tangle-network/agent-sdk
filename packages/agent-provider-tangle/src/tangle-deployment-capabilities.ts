import type {
  SandboxInstanceLike,
  SandboxRuntimeCapabilityDocument,
} from "./tangle-types.js";
import { statusFromUnknown } from "./tangle-environment-values.js";
import { awaitWithSignal } from "./tangle-contract-safety.js";

/**
 * What the connected deployment reports about the run operations this adapter
 * builds on top of a sandbox.
 *
 * Each fact is the conjunction of every document flag its operation needs, so
 * a document that reports part of an operation reports none of it. A flag the
 * document leaves unset is unknown, and unknown is never a claim: an absent,
 * unreadable, or partial document leaves every fact false.
 */
export interface DeploymentCapabilitySupport {
  /**
   * Run requests carry the caller's exact `runControlRef`, and admission
   * echoes the executionId. Detached dispatch needs both: it sends the
   * reference and refuses a receipt that does not name the execution back.
   */
  readonly exactDispatch: boolean;
  /** Cancellation is canonical, digest-bound, and idempotent under replay. */
  readonly canonicalCancellation: boolean;
  /** Buffered run events replay by execution under stable event ids. */
  readonly eventReplay: boolean;
  /** Status and results select one execution, not the session's latest. */
  readonly executionScopedStatus: boolean;
  /**
   * Interaction responses are recorded durably, so repeating one replays the
   * recorded acknowledgement instead of delivering a second answer to a
   * running agent. The adapter holds no record of its own, so this fact alone
   * decides whether a response can be retried safely.
   */
  readonly interactionResponses: boolean;
  /** Native TUI start, status, attach, prompt, stop, and profile identity. */
  readonly interactiveAgent: boolean;
}

/**
 * The deployment backs nothing.
 *
 * This is the client stage, where no sandbox exists to ask, and it is also
 * every answer that fails to establish a fact: no capability method, a sandbox
 * that cannot answer, a `null` document, a failed request, and a document that
 * leaves a required flag unset.
 */
export const UNPROVEN_DEPLOYMENT: DeploymentCapabilitySupport = {
  exactDispatch: false,
  canonicalCancellation: false,
  eventReplay: false,
  executionScopedStatus: false,
  interactionResponses: false,
  interactiveAgent: false,
};

/**
 * The client stage's deployment input: this adapter's ceiling, not a fact.
 *
 * No sandbox exists before create, so no deployment can be asked, and the
 * provider document answers a different question from the environment's — it
 * states what this adapter offers against a deployment that backs it, which is
 * what a caller selects a provider on. `AgentEnvironment.capabilities` carries
 * the measured answer for one sandbox, and every operation an environment
 * exposes follows that document, never this ceiling.
 *
 * The ceiling stays wide deliberately. A provider document that claimed
 * nothing before create would refuse retained runs against every deployment,
 * including the ones that back them, because a caller must read the provider
 * document to decide whether to start one at all.
 */
export const ADAPTER_CEILING_DEPLOYMENT: DeploymentCapabilitySupport = {
  exactDispatch: true,
  canonicalCancellation: true,
  eventReplay: true,
  executionScopedStatus: true,
  interactionResponses: true,
  interactiveAgent: true,
};

/**
 * Read the deployment facts out of a capability document. Every flag this
 * adapter acts on is read here; the shape carries no flag it does not act on.
 */
export function deploymentCapabilitySupport(
  document: SandboxRuntimeCapabilityDocument | null | undefined,
): DeploymentCapabilitySupport {
  if (!document || typeof document !== "object") return UNPROVEN_DEPLOYMENT;
  return {
    exactDispatch:
      document.dispatch?.runControlRef === true &&
      document.dispatch?.executionIdOnAdmission === true,
    canonicalCancellation:
      document.cancel?.canonicalRunCancellation === true &&
      document.cancel?.digestBound === true &&
      document.cancel?.idempotent === true,
    eventReplay: document.runs?.eventReplay === true,
    executionScopedStatus: document.runs?.executionScopedStatus === true,
    interactionResponses: document.interactions?.responseDedupe === true,
    interactiveAgent:
      document.interactiveAgent?.start === true &&
      document.interactiveAgent?.status === true &&
      document.interactiveAgent?.attach === true &&
      document.interactiveAgent?.sendPrompt === true &&
      document.interactiveAgent?.stop === true &&
      document.interactiveAgent?.profileDigest === true,
  };
}

/**
 * Establish the deployment facts for one sandbox through capability
 * discovery. Every outcome but the caller's own abort resolves to a fact set.
 *
 * Three inputs answer without a request: a Sandbox SDK older than 0.22.0,
 * which carries no `capabilities` method; a sandbox that is not running, whose
 * capability route can only answer with a state error; and a `null` document,
 * which is a deployment predating capability discovery or one serving a schema
 * this SDK cannot read.
 *
 * A failed request resolves the same way. Discovery runs against a sandbox
 * that a cold provision has just paid for, and a transport failure or a
 * defective document is not evidence about the run operations: failing here
 * would trade an unknown for the certain loss of that sandbox. The failure
 * reaches the warning channel, and the environment then offers no operation
 * the document did not prove.
 */
export async function readDeploymentCapabilitySupport(
  box: SandboxInstanceLike,
  options?: { signal?: AbortSignal },
): Promise<DeploymentCapabilitySupport> {
  if (typeof box.capabilities !== "function") return UNPROVEN_DEPLOYMENT;
  if (statusFromUnknown(box.status) !== "running") return UNPROVEN_DEPLOYMENT;
  options?.signal?.throwIfAborted();
  let document: SandboxRuntimeCapabilityDocument | null | undefined;
  try {
    document = await awaitWithSignal(box.capabilities(), options?.signal);
  } catch (error) {
    options?.signal?.throwIfAborted();
    console.warn(
      `Tangle capability discovery failed for sandbox ${box.id}: the deployment backs nothing`,
      error,
    );
    return UNPROVEN_DEPLOYMENT;
  }
  options?.signal?.throwIfAborted();
  return deploymentCapabilitySupport(document);
}

/**
 * Whether the deployment backs the complete retained-control identity set.
 * The capability schema refuses a partial retained-control block, and each
 * identity rests on its own deployment fact, so they stand together: exact
 * dispatch for run identity, execution-scoped status for result identity,
 * event replay for event identity, and canonical cancellation for
 * cancellation idempotency.
 */
export function deploymentBacksRetainedControl(
  deployment: DeploymentCapabilitySupport,
): boolean {
  return (
    deployment.exactDispatch &&
    deployment.canonicalCancellation &&
    deployment.eventReplay &&
    deployment.executionScopedStatus
  );
}

/** True only when the deployment proves the complete exact native-TUI path. */
export function deploymentBacksInteractiveAgent(
  deployment: DeploymentCapabilitySupport,
): boolean {
  return deployment.interactiveAgent;
}

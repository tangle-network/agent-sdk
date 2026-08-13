import type {
  AgentEnvironmentCapabilities,
  HarnessType,
} from "@tangle-network/agent-interface";
import { harnessSystemPromptIntents } from "@tangle-network/agent-interface";
import { SandboxInstance } from "@tangle-network/sandbox";
import type {
  SandboxClientLike,
  SandboxInstanceLike,
  SandboxSessionLike,
} from "./tangle-types.js";
import {
  ADAPTER_CEILING_DEPLOYMENT,
  deploymentBacksRetainedControl,
} from "./tangle-deployment-capabilities.js";
import type { DeploymentCapabilitySupport } from "./tangle-deployment-capabilities.js";

/**
 * The full capability document this adapter supports when the Sandbox client
 * implements every optional method.
 *
 * This is an upper bound, not a claim. `capabilitiesForClient()` narrows it
 * to the adapter surface, and `capabilitiesForSandbox()` narrows it again to
 * what the deployment behind one sandbox reports, because a capability
 * nothing backs becomes an action the caller selects and finds missing.
 */
export function defaultTangleSandboxCapabilities(
  harness?: HarnessType,
): AgentEnvironmentCapabilities {
  return {
    profile: {
      namedProfiles: true,
      systemPrompt: harnessSystemPromptIntents(harness),
      instructions: true,
      tools: true,
      permissions: true,
      mcp: true,
      subagents: true,
      resources: {
        files: true,
        instructions: true,
        tools: true,
        skills: true,
        agents: true,
        commands: true,
      },
      hooks: true,
      modes: true,
      runtimeUpdate: true,
      validation: true,
    },
    streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
    // Retained control is declared as intent here and stripped by narrowing
    // wherever the facts cannot prove dispatchPrompt, session, cancelRun,
    // and environment reconstruction by id, or wherever the deployment does
    // not report the run-control and cancellation flags. The four sub-flags
    // are all-or-nothing by design: this adapter implements the identities
    // together over one Sandbox surface, and the capability schema refuses
    // a partial block, so they stand or fall on the same fact set.
    sessions: { continue: true, list: false, messages: false },
    retainedControl: {
      exactRunIdentity: true,
      resultIdentity: true,
      eventIdentity: true,
      cancellationIdempotency: true,
    },
    workspace: { read: true, write: true, exec: true, git: false, upload: true, download: true },
    // Sandbox exposes snapshot/branch, not the checkpoint/fork contract, and
    // durable branching needs retry, lookup, conflict, and cleanup together.
    branching: { checkpoint: false, fork: false },
    placement: true,
    usage: false,
    // Confidential execution needs verified attestation evidence, which this
    // adapter does not yet obtain, so it is never declared by default.
    confidential: false,
  };
}

/**
 * Adapter-surface facts that gate declared capabilities: which methods this
 * process can actually call. Every fact defaults to false when it cannot be
 * established; a false fact clears the matching declared capability. These
 * facts bound the claim from above — what the connected deployment honors is
 * a separate fact, carried by `DeploymentCapabilitySupport`.
 */
export interface SandboxCapabilitySupport {
  /** The provider can rebuild an environment by id (`client.get`). */
  reconstruct: boolean;
  dispatchPrompt: boolean;
  session: boolean;
  read: boolean;
  write: boolean;
  exec: boolean;
  placement: boolean;
  destroy: boolean;
  cancelRun: boolean;
}

// One reserved id names both probe handles; neither ever reaches the service.
const CAPABILITY_PROBE_ID = "__tangle-capability-probe__";

export function sandboxCapabilitySupport(
  box: SandboxInstanceLike,
  client: SandboxClientLike,
): SandboxCapabilitySupport {
  let session: SandboxSessionLike | undefined;
  if (typeof box.session === "function") {
    try {
      // Sandbox session handles are lazy. Inspecting one does not call the
      // service, and keeps retained-control claims tied to the actual handle.
      session = box.session(CAPABILITY_PROBE_ID);
    } catch {
      // A client that cannot produce a session handle cannot prove retained control.
    }
  }
  return {
    reconstruct: typeof client.get === "function",
    dispatchPrompt: typeof box.dispatchPrompt === "function",
    session: typeof box.session === "function",
    read: typeof box.read === "function",
    write: typeof box.write === "function",
    exec: typeof box.exec === "function",
    placement: typeof client.describePlacement === "function",
    destroy: typeof box.delete === "function",
    cancelRun: typeof session?.cancelRun === "function",
  };
}

type SandboxHttpClient = ConstructorParameters<typeof SandboxInstance>[0];

/**
 * Mint a lazy instance handle from the sandbox SDK linked into this process.
 * The handle measures the LINKED SDK's instance and session method surface —
 * an adapter-surface fact and therefore an upper bound, never a claim that
 * the connected service honors those methods. It is valid exactly when the
 * client is SDK-backed (carries the SDK `fetch` transport), because the
 * sandboxes such a client returns are instances of these same classes.
 * Deployment truth arrives per-sandbox, from `box.capabilities()`, and can
 * only narrow this bound. The handle and its probe session never leave the
 * process: construction and `session(id)` are lazy in the SDK, so no request
 * is sent and no billable resource is created.
 */
function linkedSdkProbeInstance(
  client: SandboxClientLike,
): SandboxInstanceLike | undefined {
  if (typeof client.fetch !== "function") return undefined;
  try {
    return new SandboxInstance(client as SandboxHttpClient, {
      id: CAPABILITY_PROBE_ID,
      status: "stopped",
      createdAt: new Date(0),
    });
  } catch {
    return undefined;
  }
}

/**
 * Establish client-stage facts before any sandbox exists. Two sources: the
 * client's own members (get, describePlacement) and, for an SDK-backed client,
 * the linked SDK surface via `linkedSdkProbeInstance`. These facts bound what
 * the adapter can execute; the deployment that decides whether an execution is
 * honored is unreachable at this stage. Box-scoped workspace facts stay at the
 * declared upper bound when no handle can be minted, and each concrete sandbox
 * re-measures them in `capabilitiesForSandbox`.
 */
export function clientCapabilitySupport(
  client: SandboxClientLike,
): SandboxCapabilitySupport {
  const probe = linkedSdkProbeInstance(client);
  if (probe) return sandboxCapabilitySupport(probe, client);
  return {
    reconstruct: typeof client.get === "function",
    dispatchPrompt: true,
    session: true,
    read: true,
    write: true,
    exec: true,
    placement: typeof client.describePlacement === "function",
    destroy: true,
    cancelRun: false,
  };
}

/**
 * Decide whether retained control may be claimed.
 *
 * Two independent fact sets must agree. The adapter surface must be able to
 * execute it: exact dispatch, a session handle, canonical cancellation, and
 * environment reconstruction by id. The connected deployment must honor it:
 * exact dispatch, canonical cancellation, event replay, and execution-scoped
 * status together. A deployment that leaves any of the four unreported refuses
 * the claim even when every local method exists, because a method this process
 * can call is not a run the service retains.
 */
export function tangleRetainedControlSupported(
  declared: AgentEnvironmentCapabilities,
  support: SandboxCapabilitySupport,
  deployment: DeploymentCapabilitySupport,
): boolean {
  return (
    deploymentBacksRetainedControl(deployment) &&
    declared.sessions.continue === true &&
    declared.streaming.detach === true &&
    declared.streaming.replay === true &&
    declared.streaming.turnIdempotency === true &&
    support.reconstruct &&
    support.dispatchPrompt &&
    support.session &&
    support.cancelRun
  );
}

/**
 * Narrow a declared capability document to established facts.
 *
 * Braid derives product actions from these flags, so an over-claimed flag is
 * an offered action that throws at the moment the user selects it. Each flag
 * takes the narrowest fact set it rests on. Detached dispatch carries the
 * caller's exact `runControlRef` and refuses a receipt that does not echo the
 * execution back, and it is only reachable through a session handle, so
 * `streaming.detach` needs exact dispatch from the deployment plus both local
 * methods. Cursor replay needs the deployment's own event replay, and turn
 * idempotency needs the deployment to honor the exact reference that
 * identifies a repeated turn.
 */
export function narrowedTangleCapabilities(
  declared: AgentEnvironmentCapabilities,
  support: SandboxCapabilitySupport,
  deployment: DeploymentCapabilitySupport,
): AgentEnvironmentCapabilities {
  const supportsRetainedControl = tangleRetainedControlSupported(
    declared,
    support,
    deployment,
  );
  const supportsDetach =
    support.dispatchPrompt && support.session && deployment.exactDispatch;
  // A cleared fact forces false; a held fact passes the declared value
  // through unchanged, so a malformed declaration still reaches the schema
  // at the provider boundary instead of being laundered into a boolean.
  const narrowed = {
    ...declared,
    streaming: {
      ...declared.streaming,
      detach: supportsDetach ? declared.streaming.detach : false,
      replay:
        support.session && deployment.eventReplay
          ? declared.streaming.replay
          : false,
      turnIdempotency: deployment.exactDispatch
        ? declared.streaming.turnIdempotency
        : false,
    },
    sessions: {
      ...declared.sessions,
      continue: supportsRetainedControl ? declared.sessions.continue : false,
      list: false,
      messages: false,
    },
    workspace: {
      ...declared.workspace,
      read: support.read ? declared.workspace.read : false,
      write: support.write ? declared.workspace.write : false,
      exec: support.exec ? declared.workspace.exec : false,
      git: false,
      upload: support.write ? declared.workspace.upload : false,
      download: support.read ? declared.workspace.download : false,
    },
    branching: {
      ...declared.branching,
      checkpoint: false,
      fork: false,
      ...(declared.branching.retrySafe !== undefined ? { retrySafe: false } : {}),
      ...(declared.branching.lookup !== undefined ? { lookup: false } : {}),
      ...(declared.branching.cleanup !== undefined ? { cleanup: false } : {}),
    },
    placement: support.placement ? declared.placement : false,
    usage: false,
  };
  delete narrowed.interactions;
  delete narrowed.nativeContinuation;
  if (!supportsRetainedControl) delete narrowed.retainedControl;
  return narrowed;
}

/**
 * Narrow provider-level claims to facts the client can prove before any
 * sandbox exists.
 *
 * This document answers "what can this provider do against a deployment that
 * backs it", which is the question a caller selects a provider on. No sandbox
 * exists here, so the deployment input is the adapter's ceiling and this
 * document is a bound, never a statement about one environment. Each concrete
 * sandbox reads its own deployment in `capabilitiesForSandbox` and publishes
 * the answer as `AgentEnvironment.capabilities`, which is the document a
 * caller reads to decide which operation to offer against that environment.
 */
export function capabilitiesForClient(
  declared: AgentEnvironmentCapabilities,
  client: SandboxClientLike,
): AgentEnvironmentCapabilities {
  return narrowedTangleCapabilities(
    declared,
    clientCapabilitySupport(client),
    ADAPTER_CEILING_DEPLOYMENT,
  );
}

/**
 * Freeze a capability document before an environment publishes it.
 *
 * The document and the operations an environment exposes are decided together
 * and must stay equal, so the copy a caller holds cannot be writable: a
 * mutated flag would describe a surface this environment does not have.
 */
export function frozenCapabilityDocument<T>(document: T): T {
  if (document === null || typeof document !== "object") return document;
  for (const value of Object.values(document)) frozenCapabilityDocument(value);
  return Object.freeze(document);
}

/**
 * Narrow a declared capability document to what this Sandbox instance backs
 * and what the deployment behind it reports.
 */
export function capabilitiesForSandbox(
  declared: AgentEnvironmentCapabilities,
  support: SandboxCapabilitySupport,
  deployment: DeploymentCapabilitySupport,
): AgentEnvironmentCapabilities {
  return narrowedTangleCapabilities(declared, support, deployment);
}

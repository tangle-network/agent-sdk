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
  deploymentBacksExactDispatch,
  deploymentBacksRetainedControl,
  UNMEASURED_DEPLOYMENT,
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
 * Establish client-stage facts before any sandbox exists. Two sources:
 * the client's own members (get, describePlacement) and, for an SDK-backed
 * client, the linked SDK surface via `linkedSdkProbeInstance`. No deployment
 * is reachable at this stage, so these facts are the adapter's upper bound.
 * Retained control still fails closed: without a probe handle nothing proves
 * `cancelRun`, so the provider must not claim it. Box-scoped workspace and
 * streaming facts stay at the declared upper bound when no handle can be
 * minted — each concrete sandbox re-narrows them in `capabilitiesForSandbox`,
 * where the deployment's own document decides retained control.
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
 * a deployment that reports no exact run reference or no canonical
 * cancellation refuses the claim even when every local method exists,
 * because a method this process can call is not a run the service retains.
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
 * an offered action that throws at the moment the user selects it. Detached
 * dispatch carries the caller's exact `runControlRef` and refuses a receipt
 * that does not echo it, so `streaming.detach` needs the deployment to accept
 * that reference — one flag, narrower than the complete retained-control set.
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
    support.dispatchPrompt && deploymentBacksExactDispatch(deployment);
  // A cleared fact forces false; a held fact passes the declared value
  // through unchanged, so a malformed declaration still reaches the schema
  // at the provider boundary instead of being laundered into a boolean.
  const narrowed = {
    ...declared,
    streaming: {
      ...declared.streaming,
      detach: supportsDetach ? declared.streaming.detach : false,
      replay: support.session ? declared.streaming.replay : false,
      turnIdempotency: support.session
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
 * sandbox exists. `clientCapabilitySupport` documents which facts stay at
 * the declared upper bound when the client offers no probe surface. The
 * deployment is `unmeasured` here by construction: this stage holds no
 * sandbox, so there is nothing to ask. Each concrete sandbox re-narrows
 * against its own deployment, and can only come back equal or narrower.
 */
export function capabilitiesForClient(
  declared: AgentEnvironmentCapabilities,
  client: SandboxClientLike,
): AgentEnvironmentCapabilities {
  return narrowedTangleCapabilities(
    declared,
    clientCapabilitySupport(client),
    UNMEASURED_DEPLOYMENT,
  );
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

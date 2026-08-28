import type {
  AgentEnvironmentCapabilities,
  HarnessType,
} from "@tangle-network/agent-interface";
import { deepFreeze, harnessSystemPromptIntents } from "@tangle-network/agent-interface";
import { SandboxInstance } from "@tangle-network/sandbox";
import type { BackendRegistryEntry } from "@tangle-network/sandbox";
import type {
  SandboxClientLike,
  SandboxInstanceLike,
  SandboxSessionLike,
} from "./tangle-types.js";
import {
  ADAPTER_CEILING_DEPLOYMENT,
  deploymentBacksInteractiveAgent,
  deploymentBacksRetainedControl,
} from "./tangle-deployment-capabilities.js";
import type { DeploymentCapabilitySupport } from "./tangle-deployment-capabilities.js";
import type { ResourceProfile } from "@tangle-network/agent-interface";
import {
  clientObservationSurfaceSupport,
  observationSurfaceSupport,
  type ObservationSurfaceSupport,
} from "./tangle-observation.js";
import { sandboxBacksInteractiveTerminal } from "./tangle-terminal.js";
import { sandboxBacksInteractiveAgent } from "./tangle-interactive.js";
import { supportsWorkspaceBranching } from "./tangle-workspace-branching.js";
import type { TangleConfidentialAttestationVerifier } from "./tangle-types.js";

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
    // Answering an ask is declared as intent and stripped by narrowing unless
    // the session exposes the command route and the deployment discloses its
    // durable response record. Three claims are bounded by what the adapter
    // can establish rather than by what the route carries:
    //  - `secretAnswers` false, and no `secret` answer field: the deployment
    //    discloses nothing about resolving a one-use secret handle, and an
    //    undisclosed fact is not a claim.
    //  - `responseScopes` names `interaction` alone, for the same reason: no
    //    document states that a broader grant is honored on reuse.
    //  - `concurrentRequests` true: the command names the ask it answers, so
    //    several outstanding asks each take their own exact response.
    interactions: {
      kinds: ["question", "permission", "plan"],
      answerFieldTypes: ["text", "number", "boolean", "select"],
      responseScopes: ["interaction"],
      secretAnswers: false,
      concurrentRequests: true,
      replay: true,
      responseIdempotency: true,
    },
    retainedControl: {
      exactRunIdentity: true,
      resultIdentity: true,
      eventIdentity: true,
      cancellationIdempotency: true,
    },
    workspace: { read: true, write: true, exec: true, git: false, upload: true, download: true },
    // The complete Sandbox SDK surface backs this contract. Narrowing below
    // removes every flag when any recovery or cleanup method is absent.
    branching: {
      checkpoint: true,
      fork: true,
      retrySafe: true,
      lookup: true,
      cleanup: true,
    },
    placement: true,
    usage: false,
    // This is intent only. Narrowing requires both raw TEE evidence and the
    // caller's external provider-key verifier before the flag survives.
    confidential: true,
    // Observation surfaces are declared as intent and narrowed per sandbox to
    // the sources that can put a value on each one.
    observation: {
      identity: true,
      lifecycle: true,
      endpoint: true,
      placement: true,
      resources: true,
      resourceUse: true,
      modelUsage: true,
      computeBilling: true,
      accountUsage: true,
    },
    // The four terminal operations rest on one fact: the sandbox serves the
    // PTY socket and reports terminal metadata. They stand or fall together.
    interactiveTerminal: {
      attach: true,
      input: true,
      resize: true,
      reattach: true,
    },
    interactiveAgent: {
      start: true,
      status: true,
      attach: true,
      reattach: true,
      control: true,
      sendPrompt: true,
      input: true,
      resize: true,
      stop: true,
    },
  };
}

/**
 * Keep only interaction kinds the selected Sandbox backend advertises.
 *
 * The backend catalog is the authority for harness-specific interactions.
 * An absent entry means the provider cannot prove any interaction support.
 */
export function narrowTangleCapabilitiesToBackend(
  declared: AgentEnvironmentCapabilities,
  backend: BackendRegistryEntry | undefined,
): AgentEnvironmentCapabilities {
  if (declared.interactions === undefined || backend === undefined) {
    if (declared.interactions === undefined) return declared;
    const narrowed = { ...declared };
    delete narrowed.interactions;
    return narrowed;
  }

  const supportedKinds = new Set<string>(backend.capabilities.interactions);
  const kinds = declared.interactions.kinds.filter((kind) =>
    supportedKinds.has(kind),
  );
  if (kinds.length === 0) {
    const narrowed = { ...declared };
    delete narrowed.interactions;
    return narrowed;
  }

  return {
    ...declared,
    interactions: {
      ...declared.interactions,
      kinds,
    },
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
  /** The session handle exposes the digest-bound interaction command route. */
  respondToInteraction: boolean;
  /** Per-surface sources for the normalized observation. */
  observation: ObservationSurfaceSupport;
  /** The sandbox serves the PTY socket and reports terminal metadata. */
  interactiveTerminal: boolean;
  /** The SDK can drive the existing native TUI and read its terminal metadata. */
  interactiveAgent: boolean;
  /** Snapshot/fork methods and inventory recovery are all present. */
  workspaceBranching: boolean;
  /** The SDK can request raw TEE evidence for this sandbox. */
  confidentialAttestation: boolean;
}

// One reserved id names both probe handles; neither ever reaches the service.
const CAPABILITY_PROBE_ID = "__tangle-capability-probe__";

export function sandboxCapabilitySupport(
  box: SandboxInstanceLike,
  client: SandboxClientLike,
  requestedResources?: ResourceProfile,
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
    respondToInteraction: typeof session?.respondToInteraction === "function",
    observation: observationSurfaceSupport(box, client, requestedResources),
    interactiveTerminal: sandboxBacksInteractiveTerminal(box),
    interactiveAgent: sandboxBacksInteractiveAgent(box),
    workspaceBranching: supportsWorkspaceBranching(box, client),
    confidentialAttestation: typeof box.getTeeAttestation === "function",
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
  const observation = clientObservationSurfaceSupport(client);
  const probe = linkedSdkProbeInstance(client);
  if (probe) {
    // The probe measures the linked SDK's method surface, so it decides the
    // terminal transport. It carries no sandbox data, so the observation
    // surfaces that rest on one environment's values stay at the ceiling.
    return { ...sandboxCapabilitySupport(probe, client), observation };
  }
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
    respondToInteraction: false,
    observation,
    interactiveTerminal: true,
    interactiveAgent: false,
    workspaceBranching: false,
    confidentialAttestation: false,
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
 * Decide whether answering an interaction may be claimed.
 *
 * Two independent fact sets must agree, as they do for retained control. The
 * adapter surface must be able to send the command: a session handle exposing
 * the digest-bound route. The deployment must record what it acknowledges,
 * because this adapter keeps no resolution record of its own — every replay
 * answer comes from the deployment. A deployment that leaves the flag unset
 * refuses the claim even though the local method exists, since an
 * unrecorded response cannot be retried without risking a second answer to a
 * running agent.
 */
export function tangleInteractionResponsesSupported(
  declared: AgentEnvironmentCapabilities,
  support: SandboxCapabilitySupport,
  deployment: DeploymentCapabilitySupport,
): boolean {
  return (
    declared.interactions !== undefined &&
    deployment.interactionResponses &&
    support.session &&
    support.respondToInteraction
  );
}

/** Decide whether exact native-TUI control is both callable and deployed. */
export function tangleInteractiveAgentSupported(
  declared: AgentEnvironmentCapabilities,
  support: SandboxCapabilitySupport,
  deployment: DeploymentCapabilitySupport,
): boolean {
  return (
    declared.interactiveAgent !== undefined &&
    support.interactiveAgent &&
    deploymentBacksInteractiveAgent(deployment)
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
  options?: { confidentialAttestationVerifier?: TangleConfidentialAttestationVerifier },
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
      checkpoint: support.workspaceBranching ? declared.branching.checkpoint : false,
      fork: support.workspaceBranching ? declared.branching.fork : false,
      ...(declared.branching.retrySafe !== undefined
        ? { retrySafe: support.workspaceBranching ? declared.branching.retrySafe : false }
        : {}),
      ...(declared.branching.lookup !== undefined
        ? { lookup: support.workspaceBranching ? declared.branching.lookup : false }
        : {}),
      ...(declared.branching.cleanup !== undefined
        ? { cleanup: support.workspaceBranching ? declared.branching.cleanup : false }
        : {}),
    },
    placement: support.placement ? declared.placement : false,
    usage: false,
    ...(declared.observation === undefined
      ? {}
      : { observation: narrowedObservation(declared.observation, support.observation) }),
    ...(declared.interactiveTerminal === undefined
      ? {}
      : {
          interactiveTerminal: narrowedInteractiveTerminal(
            declared.interactiveTerminal,
            support.interactiveTerminal,
          ),
        }),
    ...(declared.interactiveAgent === undefined
      ? {}
      : {
          interactiveAgent: narrowedInteractiveAgent(
            declared.interactiveAgent,
            tangleInteractiveAgentSupported(declared, support, deployment),
          ),
        }),
  };
  // A claimed block is passed through whole. Its sub-flags state what the
  // route carries, not what one deployment reports, and the deployment's own
  // fact has already decided whether the block survives at all.
  if (!tangleInteractionResponsesSupported(declared, support, deployment)) {
    delete narrowed.interactions;
  }
  delete narrowed.nativeContinuation;
  if (!supportsRetainedControl) delete narrowed.retainedControl;
  if (
    narrowed.confidential &&
    (!support.confidentialAttestation ||
      typeof options?.confidentialAttestationVerifier !== "function")
  ) {
    narrowed.confidential = false;
  }
  return narrowed;
}

/**
 * Clear every observation surface no source backs. The flag states whether a
 * value can be produced; the observation itself always carries the surface
 * with its freshness state, so a cleared flag never turns into a missing key.
 */
function narrowedObservation(
  declared: NonNullable<AgentEnvironmentCapabilities["observation"]>,
  support: ObservationSurfaceSupport,
): NonNullable<AgentEnvironmentCapabilities["observation"]> {
  return {
    identity: support.identity ? declared.identity : false,
    lifecycle: support.lifecycle ? declared.lifecycle : false,
    endpoint: support.endpoint ? declared.endpoint : false,
    placement: support.placement ? declared.placement : false,
    resources: support.resources ? declared.resources : false,
    resourceUse: support.resourceUse ? declared.resourceUse : false,
    modelUsage: support.modelUsage ? declared.modelUsage : false,
    computeBilling: support.computeBilling ? declared.computeBilling : false,
    accountUsage: support.accountUsage ? declared.accountUsage : false,
  };
}

/**
 * The four terminal operations reach the caller through one PTY socket from
 * one linked SDK, so one fact decides them all: a sandbox that cannot serve
 * the socket claims none of them.
 */
function narrowedInteractiveTerminal(
  declared: NonNullable<AgentEnvironmentCapabilities["interactiveTerminal"]>,
  supported: boolean,
): NonNullable<AgentEnvironmentCapabilities["interactiveTerminal"]> {
  return {
    attach: supported ? declared.attach : false,
    input: supported ? declared.input : false,
    resize: supported ? declared.resize : false,
    reattach: supported ? declared.reattach : false,
  };
}

/** One fact decides the exact TUI surface because partial control is unsafe. */
function narrowedInteractiveAgent(
  declared: NonNullable<AgentEnvironmentCapabilities["interactiveAgent"]>,
  supported: boolean,
): NonNullable<AgentEnvironmentCapabilities["interactiveAgent"]> {
  return {
    start: supported ? declared.start : false,
    status: supported ? declared.status : false,
    attach: supported ? declared.attach : false,
    reattach: supported ? declared.reattach : false,
    control: supported ? declared.control : false,
    sendPrompt: supported ? declared.sendPrompt : false,
    input: supported ? declared.input : false,
    resize: supported ? declared.resize : false,
    stop: supported ? declared.stop : false,
  };
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
  options?: { confidentialAttestationVerifier?: TangleConfidentialAttestationVerifier },
): AgentEnvironmentCapabilities {
  return narrowedTangleCapabilities(
    declared,
    clientCapabilitySupport(client),
    ADAPTER_CEILING_DEPLOYMENT,
    options,
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
  return deepFreeze(document);
}

/**
 * Narrow a declared capability document to what this Sandbox instance backs
 * and what the deployment behind it reports.
 */
export function capabilitiesForSandbox(
  declared: AgentEnvironmentCapabilities,
  support: SandboxCapabilitySupport,
  deployment: DeploymentCapabilitySupport,
  options?: { confidentialAttestationVerifier?: TangleConfidentialAttestationVerifier },
): AgentEnvironmentCapabilities {
  return narrowedTangleCapabilities(declared, support, deployment, options);
}

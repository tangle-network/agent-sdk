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

/**
 * The full capability document this adapter supports when the Sandbox client
 * implements every optional method.
 *
 * This is an upper bound, not a claim. `capabilitiesForClient()` and
 * `capabilitiesForSandbox()` narrow it to what the deployment actually
 * exposes, because a capability the client cannot back becomes an action the
 * caller selects and finds missing.
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
    // and environment reconstruction by id. The four sub-flags are
    // all-or-nothing by design: this adapter implements the identities
    // together over one Sandbox surface, and the capability schema refuses
    // a partial block, so they stand or fall on the same probed fact set.
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
 * Deployment facts that gate declared capabilities. Every fact defaults to
 * false when it cannot be established; a false fact clears the matching
 * declared capability.
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
 * an adapter-capability fact, not deployment truth. It is valid exactly when
 * the client is SDK-backed (carries the SDK `fetch` transport), because the
 * sandboxes such a client returns are instances of these same classes.
 * Deployment truth (what the connected service honors) needs the sidecar
 * capability endpoint and is a follow-up. The handle and its probe session
 * never leave the process: construction and `session(id)` are lazy in the
 * SDK, so no request is sent and no billable resource is created.
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
 * client, the linked SDK surface via `linkedSdkProbeInstance`. Retained
 * control fails closed: without a probe handle nothing proves `cancelRun`,
 * so the provider must not claim it. Box-scoped workspace and streaming
 * facts stay at the declared upper bound when no handle can be minted —
 * each concrete sandbox re-narrows them in `capabilitiesForSandbox`.
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
 * Narrow a declared capability document to established facts.
 *
 * Braid derives product actions from these flags, so an over-claimed flag is
 * an offered action that throws at the moment the user selects it. Retained
 * control requires the complete fact set: exact dispatch, a session handle,
 * canonical cancellation, and environment reconstruction by id.
 */
export function narrowedTangleCapabilities(
  declared: AgentEnvironmentCapabilities,
  support: SandboxCapabilitySupport,
): AgentEnvironmentCapabilities {
  const supportsRetainedControl =
    declared.sessions.continue === true &&
    declared.streaming.detach === true &&
    declared.streaming.replay === true &&
    declared.streaming.turnIdempotency === true &&
    support.reconstruct &&
    support.dispatchPrompt &&
    support.session &&
    support.cancelRun;
  // A cleared fact forces false; a held fact passes the declared value
  // through unchanged, so a malformed declaration still reaches the schema
  // at the provider boundary instead of being laundered into a boolean.
  const narrowed = {
    ...declared,
    streaming: {
      ...declared.streaming,
      detach: support.dispatchPrompt ? declared.streaming.detach : false,
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
 * the declared upper bound when the client offers no probe surface.
 */
export function capabilitiesForClient(
  declared: AgentEnvironmentCapabilities,
  client: SandboxClientLike,
): AgentEnvironmentCapabilities {
  return narrowedTangleCapabilities(declared, clientCapabilitySupport(client));
}

/** Narrow a declared capability document to what this Sandbox instance backs. */
export function capabilitiesForSandbox(
  declared: AgentEnvironmentCapabilities,
  support: SandboxCapabilitySupport,
): AgentEnvironmentCapabilities {
  return narrowedTangleCapabilities(declared, support);
}

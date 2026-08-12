import type {
  AgentEnvironmentCapabilities,
  HarnessType,
} from "@tangle-network/agent-interface";
import { harnessSystemPromptIntents } from "@tangle-network/agent-interface";
import type {
  SandboxClientLike,
  SandboxInstanceLike,
  SandboxSessionLike,
} from "./tangle-types.js";

/**
 * The full capability document this adapter supports when the Sandbox client
 * implements every optional method.
 *
 * This is an upper bound, not a claim. `capabilitiesForSandbox()` narrows it
 * to what a specific client actually exposes, because a capability the client
 * cannot back becomes an action the caller selects and finds missing.
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
    // A Sandbox session id is not a Braid context-boundary proof. Native
    // continuation stays unavailable until this adapter can verify one.
    // Retained control stays opt-in until a concrete session exposes cancelRun.
    sessions: { continue: false, list: false, messages: false },
    workspace: { read: true, write: true, exec: true, git: false, upload: true, download: true },
    branching: { checkpoint: false, fork: false },
    placement: true,
    usage: false,
    // Confidential execution needs verified attestation evidence, which this
    // adapter does not yet obtain, so it is never declared by default.
    confidential: false,
  };
}

/** Optional methods whose absence must clear the matching declared capability. */
export interface SandboxCapabilitySupport {
  dispatchPrompt: boolean;
  session: boolean;
  read: boolean;
  write: boolean;
  exec: boolean;
  checkpoint: boolean;
  fork: boolean;
  placement: boolean;
  destroy: boolean;
  cancelRun: boolean;
}

const CAPABILITY_PROBE_SESSION_ID = "__tangle-capability-probe__";

export function sandboxCapabilitySupport(
  box: SandboxInstanceLike,
  client: SandboxClientLike,
): SandboxCapabilitySupport {
  let session: SandboxSessionLike | undefined;
  if (typeof box.session === "function") {
    try {
      // Sandbox session handles are lazy. Inspecting one does not call the
      // service, and keeps retained-control claims tied to the actual handle.
      session = box.session(CAPABILITY_PROBE_SESSION_ID);
    } catch {
      // A client that cannot produce a session handle cannot prove retained control.
    }
  }
  return {
    dispatchPrompt: typeof box.dispatchPrompt === "function",
    session: typeof box.session === "function",
    read: typeof box.read === "function",
    write: typeof box.write === "function",
    exec: typeof box.exec === "function",
    checkpoint: typeof box.checkpoint === "function",
    fork: typeof box.fork === "function",
    placement: typeof client.describePlacement === "function",
    destroy: typeof box.delete === "function",
    cancelRun: typeof session?.cancelRun === "function",
  };
}

/**
 * Narrow provider-level claims to capabilities the client can actually back.
 *
 * A client without placement metadata cannot satisfy placement(), and this
 * adapter has no durable branching, interaction, or native-continuation
 * implementation regardless of an overly broad configured document.
 * Per-sandbox retained-run claims are narrowed later, after a concrete
 * session handle proves that cancelRun is available.
 */
export function capabilitiesForClient(
  declared: AgentEnvironmentCapabilities,
  client: SandboxClientLike,
): AgentEnvironmentCapabilities {
  const canReconstructRetainedEnvironment = typeof client.get === "function";
  const narrowed = {
    ...declared,
    streaming: {
      ...declared.streaming,
      replay: declared.streaming.replay,
      detach: declared.streaming.detach,
      turnIdempotency: declared.streaming.turnIdempotency,
    },
    sessions: {
      ...declared.sessions,
      continue:
        declared.sessions.continue && canReconstructRetainedEnvironment,
      list: false,
      messages: false,
    },
    workspace: { ...declared.workspace, git: false },
    usage: false,
    branching: {
      ...declared.branching,
      checkpoint: false,
      fork: false,
      ...(declared.branching.retrySafe !== undefined ? { retrySafe: false } : {}),
      ...(declared.branching.lookup !== undefined ? { lookup: false } : {}),
      ...(declared.branching.cleanup !== undefined ? { cleanup: false } : {}),
    },
    placement:
      declared.placement && typeof client.describePlacement === "function",
  };
  delete narrowed.interactions;
  if (!canReconstructRetainedEnvironment) delete narrowed.retainedControl;
  delete narrowed.nativeContinuation;
  return narrowed;
}

/**
 * Narrow a declared capability document to what this Sandbox instance backs.
 *
 * Braid derives product actions from these flags, so an over-claimed flag is
 * an offered action that throws at the moment the user selects it.
 */
export function capabilitiesForSandbox(
  declared: AgentEnvironmentCapabilities,
  support: SandboxCapabilitySupport,
): AgentEnvironmentCapabilities {
  const narrowed = { ...declared };
  const supportsRetainedControl =
    declared.sessions.continue &&
    declared.streaming.detach &&
    declared.streaming.replay &&
    declared.streaming.turnIdempotency &&
    support.dispatchPrompt &&
    support.session &&
    support.cancelRun;
  delete narrowed.interactions;
  delete narrowed.nativeContinuation;
  if (!supportsRetainedControl) delete narrowed.retainedControl;
  return {
    ...narrowed,
    streaming: {
      ...declared.streaming,
      detach: declared.streaming.detach && support.dispatchPrompt,
      replay: declared.streaming.replay && support.session,
      turnIdempotency: declared.streaming.turnIdempotency && support.session,
    },
    sessions: {
      ...declared.sessions,
      continue: declared.sessions.continue && supportsRetainedControl,
      list: false,
      messages: false,
    },
    workspace: {
      ...declared.workspace,
      read: declared.workspace.read && support.read,
      write: declared.workspace.write && support.write,
      exec: declared.workspace.exec && support.exec,
      git: false,
      upload: declared.workspace.upload && support.write,
      download: declared.workspace.download && support.read,
    },
    branching: {
      ...narrowed.branching,
      checkpoint: false,
      fork: false,
      ...(declared.branching.retrySafe !== undefined
        ? { retrySafe: false }
        : {}),
      ...(declared.branching.lookup !== undefined ? { lookup: false } : {}),
      ...(declared.branching.cleanup !== undefined ? { cleanup: false } : {}),
    },
    placement: narrowed.placement && support.placement,
    usage: false,
  };
}

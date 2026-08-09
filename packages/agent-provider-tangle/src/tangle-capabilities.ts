import type { AgentEnvironmentCapabilities } from "@tangle-network/agent-interface/environment-provider";
import type { SandboxClientLike, SandboxInstanceLike } from "./tangle-types.js";

/**
 * The full capability document this adapter supports when the Sandbox client
 * implements every optional method.
 *
 * This is an upper bound, not a claim. `capabilitiesForSandbox()` narrows it
 * to what a specific client actually exposes, because a capability the client
 * cannot back becomes an action the caller selects and finds missing.
 */
export function defaultTangleSandboxCapabilities(): AgentEnvironmentCapabilities {
  return {
    profile: {
      namedProfiles: true,
      systemPrompt: true,
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
}

export function sandboxCapabilitySupport(
  box: SandboxInstanceLike,
  client: SandboxClientLike,
): SandboxCapabilitySupport {
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
  };
}

/**
 * Narrow provider-level claims to capabilities the client can actually back.
 *
 * A client without placement metadata cannot satisfy placement(), and this
 * adapter has no durable branching, interaction, or native-continuation
 * implementation regardless of an overly broad configured document.
 */
export function capabilitiesForClient(
  declared: AgentEnvironmentCapabilities,
  client: SandboxClientLike,
): AgentEnvironmentCapabilities {
  const narrowed = {
    ...declared,
    streaming: {
      ...declared.streaming,
      replay: declared.streaming.replay,
      detach: declared.streaming.detach,
      turnIdempotency: declared.streaming.turnIdempotency,
    },
    sessions: { ...declared.sessions, continue: false, list: false, messages: false },
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
  delete narrowed.retainedControl;
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
  delete narrowed.interactions;
  delete narrowed.retainedControl;
  delete narrowed.nativeContinuation;
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
      continue: false,
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

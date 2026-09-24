import { randomUUID } from "node:crypto";

import {
  agentProfileSchema,
  canonicalCandidateDigest,
  type AgentProfile,
  type AgentRuntimeAttachments,
} from "@tangle-network/agent-interface";
import type {
  AgentEnvironmentSummary,
  CreateAgentEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";
import type { PromptOptions, SandboxEvent } from "@tangle-network/sandbox";

import { assertBoundedJson, boundedIdentifier } from "./tangle-contract-safety.js";
import { statusFromUnknown } from "./tangle-environment-values.js";
import { tangleRuntimeAttachments } from "./tangle-runtime-attachments.js";
import type {
  SandboxInstanceLike,
  SandboxSessionLike,
  TangleSharedSandboxOptions,
  TangleSandboxPlacement,
} from "./tangle-types.js";

/**
 * Metadata key that marks a sandbox as shared. Its value is the pool key, a
 * digest of the sandbox-level create input, so a restarted process can tell a
 * shared sandbox from a dedicated one without trusting any agent's metadata.
 */
export const TANGLE_SHARED_SANDBOX_METADATA_KEY = "tangleSharedSandbox";

/**
 * Create fields that belong to one agent rather than to its sandbox. Every
 * other field configures the sandbox itself (image, resources, environment
 * variables, secrets, egress, billing), so agents share a sandbox only when
 * those fields are canonically equal.
 */
const AGENT_FIELDS = new Set([
  "profile",
  "runtimeAttachments",
  "metadata",
  "name",
  "idempotencyKey",
  "signal",
]);

interface Lease {
  readonly id: string;
  readonly sandbox: SharedSandbox;
  /** The authored inline profile, sent unchanged on every turn. */
  readonly profile: AgentProfile;
  readonly profileDigest: string;
  readonly runtimeAttachments?: AgentRuntimeAttachments;
  readonly metadata: Record<string, unknown>;
  released: boolean;
}

interface SharedSandbox {
  readonly key: string;
  readonly harness: string;
  /** Resolves once the sandbox is running; rejects when provisioning fails. */
  readonly ready: Promise<SandboxInstanceLike>;
  box?: SandboxInstanceLike;
  /** Leases held or waiting on `ready`. */
  holders: number;
  /** Set once the sandbox may take no new lease. */
  retired: boolean;
  deletion?: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
  /**
   * A new sandbox installs its model credential on the first admitted turn,
   * and it refuses every concurrent first turn with
   * MODEL_CREDENTIAL_SUPERSEDED (measured 2026-09-24: 5 of 6 concurrent first
   * prompts on a cold sandbox). Turns wait here until one is admitted.
   */
  admitted: boolean;
  admission: Promise<void>;
}

/** What the provider supplies: one sandbox create that waits for `running`. */
export interface SharedSandboxHost {
  provision(input: CreateAgentEnvironmentInput): Promise<SandboxInstanceLike>;
  harnessFor(input: CreateAgentEnvironmentInput): string;
  /** The stored model credential a dedicated sandbox would carry at create, sent on each turn instead. */
  turnModel?: { apiKeyEnv: string; baseUrl: string };
}

export interface LeasedSandbox {
  readonly box: SandboxInstanceLike;
  readonly sandbox: SandboxInstanceLike;
}

export interface SharedSandboxPool {
  placement(input: CreateAgentEnvironmentInput): TangleSandboxPlacement;
  lease(input: CreateAgentEnvironmentInput): Promise<LeasedSandbox>;
  /** One summary per live lease; a retained run proves ownership through these. */
  summaries(providerName: string): AgentEnvironmentSummary[];
  /** Wrap a sandbox reconstructed by id, when it is shared. */
  reconstruct(box: SandboxInstanceLike): SandboxInstanceLike;
}

/** Default placement: a repository workspace is written by one agent alone. */
function defaultPlacement(input: CreateAgentEnvironmentInput): TangleSandboxPlacement {
  if (input.workspace?.repoUrl !== undefined) return "dedicated";
  return "shared";
}

export function validateSharedSandboxOptions(options: TangleSharedSandboxOptions): void {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Tangle sharedSandboxes must be an object");
  }
  for (const key of Object.keys(options)) {
    if (!["agentsPerSandbox", "idleMs", "placement"].includes(key)) {
      throw new Error(`Tangle sharedSandboxes.${key} is not supported`);
    }
  }
  if (!Number.isSafeInteger(options.agentsPerSandbox) || options.agentsPerSandbox < 1) {
    throw new Error("Tangle sharedSandboxes.agentsPerSandbox must be a positive integer");
  }
  if (
    options.idleMs !== undefined &&
    (!Number.isSafeInteger(options.idleMs) || options.idleMs < 0)
  ) {
    throw new Error("Tangle sharedSandboxes.idleMs must be a non-negative integer");
  }
  if (options.placement !== undefined && typeof options.placement !== "function") {
    throw new Error("Tangle sharedSandboxes.placement must be a function");
  }
}

/**
 * Place many agents in one sandbox.
 *
 * Each agent keeps what makes it one agent: its own Sandbox session and
 * native harness session, its own profile and runtime attachments on every
 * turn, and therefore its own harness process and HOME (the sidecar keys a
 * backend by profile, attachments and credentials). Agents in one sandbox
 * share its workspace directory, CPU and memory, and can read one another's
 * files; they are one trust domain. An agent that needs its own filesystem —
 * repository writes, untrusted code — takes a dedicated sandbox through
 * `placement`.
 */
export function createSharedSandboxPool(
  options: TangleSharedSandboxOptions,
  host: SharedSandboxHost,
): SharedSandboxPool {
  validateSharedSandboxOptions(options);
  const capacity = options.agentsPerSandbox;
  const idleMs = options.idleMs ?? 0;
  const pools = new Map<string, SharedSandbox[]>();
  const leases = new Map<string, Lease>();
  // A retained turn names its session; a later turn in that session (or a
  // reconstructed handle) must run the same agent, so sessions outlive leases.
  const sessionAgents = new Map<string, Lease>();
  const admissionOpeners = new WeakMap<SharedSandbox, () => void>();
  // One first turn at a time per new sandbox, in arrival order.
  const admissionTurns = new WeakMap<SharedSandbox, Promise<void>>();

  const retire = (sandbox: SharedSandbox): Promise<void> => {
    sandbox.retired = true;
    if (sandbox.idleTimer !== undefined) clearTimeout(sandbox.idleTimer);
    const siblings = pools.get(sandbox.key);
    if (siblings) {
      const remaining = siblings.filter((entry) => entry !== sandbox);
      if (remaining.length === 0) pools.delete(sandbox.key);
      else pools.set(sandbox.key, remaining);
    }
    if (!sandbox.box?.delete) return Promise.resolve();
    const box = sandbox.box;
    sandbox.deletion ??= Promise.resolve(box.delete?.())
      .then(() => undefined)
      .catch((error: unknown) => {
        // A failed delete is not remembered; the next release asks again.
        sandbox.deletion = undefined;
        throw error;
      });
    return sandbox.deletion;
  };

  const release = async (lease: Lease): Promise<void> => {
    if (!lease.released) {
      lease.released = true;
      leases.delete(lease.id);
      lease.sandbox.holders -= 1;
    }
    await settleEmpty(lease.sandbox);
  };

  // Called whenever a holder leaves: an empty sandbox is deleted now, or after idleMs.
  const settleEmpty = async (sandbox: SharedSandbox): Promise<void> => {
    if (sandbox.holders > 0 || sandbox.box === undefined) return;
    if (sandbox.retired) {
      await retire(sandbox);
      return;
    }
    if (idleMs === 0) {
      await retire(sandbox);
      return;
    }
    if (sandbox.idleTimer !== undefined) clearTimeout(sandbox.idleTimer);
    sandbox.idleTimer = setTimeout(() => {
      sandbox.idleTimer = undefined;
      if (sandbox.holders === 0 && !sandbox.retired) void retire(sandbox).catch(() => undefined);
    }, idleMs);
    sandbox.idleTimer.unref?.();
  };

  const place = (key: string, harness: string, input: CreateAgentEnvironmentInput): SharedSandbox => {
    const candidates = (pools.get(key) ?? []).filter(
      (sandbox) => !sandbox.retired && sandbox.holders < capacity,
    );
    // Fill the fullest sandbox first, so a lightly used one empties and is released.
    candidates.sort((a, b) => b.holders - a.holders);
    const chosen = candidates[0];
    if (chosen) {
      chosen.holders += 1;
      if (chosen.idleTimer !== undefined) {
        clearTimeout(chosen.idleTimer);
        chosen.idleTimer = undefined;
      }
      return chosen;
    }
    let admitted!: () => void;
    const sandbox: SharedSandbox = {
      key,
      harness,
      ready: undefined as unknown as Promise<SandboxInstanceLike>,
      holders: 1,
      retired: false,
      admitted: false,
      admission: new Promise<void>((resolve) => {
        admitted = resolve;
      }),
    };
    admissionOpeners.set(sandbox, admitted);
    const { signal: _signal, ...rest } = input;
    const provisionInput: CreateAgentEnvironmentInput = {
      ...Object.fromEntries(Object.entries(rest).filter(([field]) => !AGENT_FIELDS.has(field))),
      profile: input.profile,
      metadata: { [TANGLE_SHARED_SANDBOX_METADATA_KEY]: key },
    };
    (sandbox as { ready: Promise<SandboxInstanceLike> }).ready = host
      .provision(provisionInput)
      .then((box) => {
        sandbox.box = box;
        return box;
      });
    // A provisioning failure is each waiting lease's failure; none may reuse it.
    sandbox.ready.catch(() => {
      sandbox.retired = true;
      const siblings = pools.get(key);
      if (siblings) pools.set(key, siblings.filter((entry) => entry !== sandbox));
    });
    pools.set(key, [...(pools.get(key) ?? []), sandbox]);
    return sandbox;
  };

  const admit = async <T>(
    sandbox: SharedSandbox,
    attempt: () => Promise<{ value: T; admitted: boolean }>,
  ): Promise<T> => {
    if (sandbox.admitted) return (await attempt()).value;
    const previous = admissionTurns.get(sandbox) ?? Promise.resolve();
    let done!: () => void;
    const turn = new Promise<void>((resolve) => {
      done = resolve;
    });
    admissionTurns.set(sandbox, previous.then(() => turn));
    await Promise.race([previous, sandbox.admission]);
    if (sandbox.admitted) {
      done();
      return (await attempt()).value;
    }
    try {
      const result = await attempt();
      if (result.admitted) {
        sandbox.admitted = true;
        admissionOpeners.get(sandbox)?.();
      }
      return result.value;
    } finally {
      done();
    }
  };

  const turnOptions = (lease: Lease, options: PromptOptions | undefined): PromptOptions => {
    const sandbox = lease.sandbox;
    const requested = options?.backend;
    if (requested?.type !== undefined && requested.type !== sandbox.harness) {
      throw new Error(
        `Tangle shared sandbox: a turn asked for backend ${requested.type} in an agent placed on ${sandbox.harness}`,
      );
    }
    if (
      requested?.profile !== undefined &&
      canonicalCandidateDigest(agentProfileSchema.parse(requested.profile)) !== lease.profileDigest
    ) {
      throw new Error("Tangle shared sandbox: a turn cannot run another profile in this agent's lease");
    }
    if (
      requested?.runtimeAttachments !== undefined &&
      (lease.runtimeAttachments === undefined ||
        canonicalCandidateDigest(requested.runtimeAttachments) !==
          canonicalCandidateDigest(lease.runtimeAttachments))
    ) {
      throw new Error("Tangle shared sandbox: a turn cannot replace this agent's runtime attachments");
    }
    if (options?.sessionId !== undefined) {
      const owner = sessionAgents.get(options.sessionId);
      if (owner !== undefined && owner.id !== lease.id) {
        throw new Error("Tangle shared sandbox: this session belongs to another agent");
      }
      sessionAgents.set(options.sessionId, lease);
    }
    return {
      ...options,
      backend: {
        ...requested,
        ...(host.turnModel === undefined && requested?.model === undefined
          ? {}
          : { model: { ...host.turnModel, ...requested?.model } }),
        type: sandbox.harness as NonNullable<PromptOptions["backend"]>["type"],
        profile: lease.profile,
        ...(lease.runtimeAttachments === undefined
          ? {}
          : { runtimeAttachments: lease.runtimeAttachments }),
      },
    } as PromptOptions;
  };

  const streamThrough = (
    lease: Lease,
    box: SandboxInstanceLike,
    message: Parameters<SandboxInstanceLike["streamPrompt"]>[0],
    options: PromptOptions | undefined,
  ): AsyncGenerator<SandboxEvent> => {
    const sandbox = lease.sandbox;
    const prepared = turnOptions(lease, options);
    return (async function* () {
      let iterator: AsyncIterator<SandboxEvent> | undefined;
      let first: IteratorResult<SandboxEvent> | undefined;
      await admit(sandbox, async () => {
        iterator = box.streamPrompt(message, prepared)[Symbol.asyncIterator]();
        first = await iterator.next();
        const event = first.done ? undefined : first.value;
        return { value: undefined, admitted: event !== undefined && event.type !== "error" };
      });
      if (!iterator || !first || first.done) return;
      yield first.value;
      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    })();
  };

  const leaseSession = (lease: Lease, session: SandboxSessionLike): SandboxSessionLike =>
    new Proxy(session, {
      get(target, property) {
        // A native TUI attaches to the whole sandbox, not to one agent.
        if (property === "interactive") return undefined;
        if (property === "prompt") {
          return (message: Parameters<SandboxSessionLike["prompt"]>[0], options?: PromptOptions) =>
            admit(lease.sandbox, async () => ({
              value: await target.prompt(message, turnOptions(lease, { ...options, sessionId: target.id })),
              admitted: true,
            }));
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });

  const leaseView = (lease: Lease, box: SandboxInstanceLike): SandboxInstanceLike => {
    const view: SandboxInstanceLike = {
      id: box.id,
      ...(box.name === undefined ? {} : { name: box.name }),
      get status() {
        return box.status;
      },
      metadata: { ...box.metadata, ...lease.metadata },
      ...(box.backend === undefined ? {} : { backend: box.backend }),
      ...(box.expiresAt === undefined ? {} : { expiresAt: box.expiresAt }),
      ...(box.createdAt === undefined ? {} : { createdAt: box.createdAt }),
      streamPrompt: (message, options) => streamThrough(lease, box, message, options),
      ...(box.prompt
        ? {
            prompt: (message: Parameters<SandboxInstanceLike["streamPrompt"]>[0], options?: PromptOptions) =>
              admit(lease.sandbox, async () => ({
                value: await box.prompt!(message, turnOptions(lease, options)),
                admitted: true,
              })),
          }
        : {}),
      ...(box.dispatchPrompt
        ? {
            dispatchPrompt: (message: Parameters<SandboxInstanceLike["streamPrompt"]>[0], options?: PromptOptions) =>
              admit(lease.sandbox, async () => ({
                value: await box.dispatchPrompt!(message, turnOptions(lease, options)),
                admitted: true,
              })),
          }
        : {}),
      ...(box.session
        ? {
            session: (id: string, options?: { signal?: AbortSignal }) =>
              leaseSession(lease, box.session!(id, options)),
          }
        : {}),
      ...(box.read ? { read: box.read.bind(box) } : {}),
      ...(box.write ? { write: box.write.bind(box) } : {}),
      ...(box.exec ? { exec: box.exec.bind(box) } : {}),
      ...(box.fs ? { fs: box.fs } : {}),
      ...(box.capabilities ? { capabilities: box.capabilities.bind(box) } : {}),
      ...(box.refresh ? { refresh: box.refresh.bind(box) } : {}),
      // This call created the lease; releasing it is this handle's whole destroy.
      createReceipt: () => ({ outcome: "created", idempotencyKeyApplied: false }),
      delete: async () => {
        await release(lease);
      },
    };
    return view;
  };

  return {
    placement(input) {
      const chosen = (options.placement ?? defaultPlacement)(input);
      if (chosen !== "shared" && chosen !== "dedicated") {
        throw new Error(`Tangle sharedSandboxes.placement returned ${String(chosen)}`);
      }
      // A caller-owned sandbox id names exactly one sandbox.
      if (chosen === "shared" && input.requestedId !== undefined) return "dedicated";
      return chosen;
    },
    async lease(input) {
      input.signal?.throwIfAborted();
      if (typeof input.profile !== "object") {
        throw new Error("Tangle shared sandbox requires an inline AgentProfile");
      }
      const profile = input.profile as AgentProfile;
      const profileDigest = canonicalCandidateDigest(agentProfileSchema.parse(profile));
      const runtimeAttachments =
        input.runtimeAttachments === undefined
          ? undefined
          : tangleRuntimeAttachments(input.runtimeAttachments, profile);
      const metadata = input.metadata ?? {};
      if (Object.hasOwn(metadata, TANGLE_SHARED_SANDBOX_METADATA_KEY)) {
        throw new Error(`Tangle metadata key ${TANGLE_SHARED_SANDBOX_METADATA_KEY} is reserved`);
      }
      assertBoundedJson(metadata, "Tangle shared sandbox lease metadata");
      const harness = host.harnessFor(input);
      const sandboxLevel = Object.fromEntries(
        Object.entries(input).filter(([field, value]) => !AGENT_FIELDS.has(field) && value !== undefined),
      );
      const key = canonicalCandidateDigest({ harness, sandbox: sandboxLevel }).slice(0, 32);
      // A sandbox that stopped under its agents takes no new one.
      for (;;) {
        const sandbox = place(key, harness, input);
        let box: SandboxInstanceLike;
        try {
          box = await sandbox.ready;
          input.signal?.throwIfAborted();
        } catch (error) {
          sandbox.holders -= 1;
          await settleEmpty(sandbox).catch(() => undefined);
          throw error;
        }
        if (box.refresh && sandbox.box !== undefined && sandbox.admitted) {
          try {
            await box.refresh(input.signal);
          } catch {
            // An unreadable status is judged below from the last known value.
          }
        }
        if (statusFromUnknown(box.status) !== "running") {
          sandbox.retired = true;
          sandbox.holders -= 1;
          await settleEmpty(sandbox).catch(() => undefined);
          continue;
        }
        const lease: Lease = {
          id: randomUUID(),
          sandbox,
          profile,
          profileDigest,
          ...(runtimeAttachments === undefined ? {} : { runtimeAttachments }),
          metadata,
          released: false,
        };
        leases.set(lease.id, lease);
        return { box: leaseView(lease, box), sandbox: box };
      }
    },
    summaries(providerName) {
      return [...leases.values()].map((lease) => ({
        id: boundedIdentifier(lease.sandbox.box!.id, "Tangle environment id"),
        provider: providerName,
        status: statusFromUnknown(lease.sandbox.box!.status),
        metadata: { ...lease.sandbox.box!.metadata, ...lease.metadata },
      }));
    },
    reconstruct(box) {
      if (box.metadata?.[TANGLE_SHARED_SANDBOX_METADATA_KEY] === undefined) return box;
      // A handle rebuilt by id serves whichever agents reach it through their sessions. Runtime
      // rebuilds one per retained agent right after dispatch and destroys the agent through it,
      // so destroy releases exactly the agents this handle served, never the sandbox's others.
      const served = new Set<Lease>();
      const agentFor = (sessionId: string | undefined): Lease | undefined => {
        const lease = sessionId === undefined ? undefined : sessionAgents.get(sessionId);
        if (lease === undefined || lease.sandbox.box?.id !== box.id) return undefined;
        served.add(lease);
        return lease;
      };
      const requireAgent = (options: PromptOptions | undefined): Lease => {
        const lease = agentFor(options?.sessionId);
        if (lease === undefined) {
          throw new Error(
            "Tangle shared sandbox: this process holds no agent for that session, so it cannot start a turn there",
          );
        }
        return lease;
      };
      return {
        id: box.id,
        ...(box.name === undefined ? {} : { name: box.name }),
        ...(box.metadata === undefined ? {} : { metadata: box.metadata }),
        ...(box.backend === undefined ? {} : { backend: box.backend }),
        get status() {
          return box.status;
        },
        streamPrompt: (message, options) => streamThrough(requireAgent(options), box, message, options),
        ...(box.dispatchPrompt
          ? {
              dispatchPrompt: (message: Parameters<SandboxInstanceLike["streamPrompt"]>[0], options?: PromptOptions) => {
                const lease = requireAgent(options);
                return box.dispatchPrompt!(message, turnOptions(lease, options));
              },
            }
          : {}),
        ...(box.session
          ? {
              session: (id: string, options?: { signal?: AbortSignal }) => {
                const session = box.session!(id, options);
                const lease = agentFor(id);
                return lease === undefined ? session : leaseSession(lease, session);
              },
            }
          : {}),
        ...(box.read ? { read: box.read.bind(box) } : {}),
        ...(box.write ? { write: box.write.bind(box) } : {}),
        ...(box.exec ? { exec: box.exec.bind(box) } : {}),
        ...(box.capabilities ? { capabilities: box.capabilities.bind(box) } : {}),
        ...(box.refresh ? { refresh: box.refresh.bind(box) } : {}),
        delete: async () => {
          if (served.size > 0) {
            for (const lease of served) await release(lease);
            return;
          }
          // Without an agent of this process to release, deleting would end agents this
          // process cannot see, such as the ones a restarted process has not reattached yet.
          // The sandbox's own idle timeout and lifetime end it instead.
          throw new Error(
            "Tangle shared sandbox: this handle served no agent of this process, so it leaves the sandbox to its idle timeout",
          );
        },
      } as SandboxInstanceLike;
    },
  };
}

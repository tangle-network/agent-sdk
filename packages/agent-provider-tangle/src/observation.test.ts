import { describe, expect, it } from "vitest";
import type {
  GpuLease,
  SandboxConnection,
  SandboxEvent,
  SandboxResourceUsage,
} from "@tangle-network/sandbox";
import {
  AgentEnvironmentObservationSchema,
  SafeEndpointSchema,
  agentEnvironmentObservationIdentityMatches,
  observationContainsCredential,
} from "@tangle-network/agent-interface";
import type { AgentEnvironmentObservation } from "@tangle-network/agent-interface";
import {
  createTangleProvider,
  type SandboxClientLike,
  type SandboxConnectionLike,
  type SandboxGpuLeaseLike,
  type SandboxInstanceLike,
  type SandboxResourceUsageLike,
} from "./index.js";
import { sandboxOptionsFromCreateInput } from "./tangle-create-options.js";
import { requestedResourceProfile } from "./tangle-resources.js";

/**
 * The published SDK shapes are the wire facts this adapter reads. Assigning
 * them to the adapter's own shapes holds the two together: a field the SDK
 * renames or retypes fails here instead of silently reading as absent.
 */
const PUBLISHED_CONNECTION: SandboxConnection = {
  runtimeUrl: "https://runtime.example:8443/v1",
  authToken: "sbx-bearer-value",
  authTokenExpiresAt: "2026-08-14T00:00:00.000Z",
};
const PUBLISHED_CONNECTION_AS_READ: SandboxConnectionLike = PUBLISHED_CONNECTION;
const PUBLISHED_USAGE: SandboxResourceUsage = {
  cgroupVersion: 2,
  memoryCurrentMb: 512,
  memoryPeakMb: 900,
  memoryLimitMb: 4_096,
  cpuUsageUsec: 12_345,
  sampledAtMs: Date.parse("2026-08-13T12:00:00.000Z"),
};
const PUBLISHED_USAGE_AS_READ: SandboxResourceUsageLike = PUBLISHED_USAGE;
const PUBLISHED_LEASE: GpuLease = {
  id: "lease-1",
  projectRef: "project-1",
  ownerUserId: "user-1",
  provider: "runpod",
  status: "ready",
  accelerator: { kind: "nvidia-h100", count: 2, memoryMB: 81_920 },
  maxSpendUsd: 100,
  maxLifetimeSeconds: 3_600,
  estimatedCustomerCostUsd: 4.25,
  createdAt: "2026-08-13T10:00:00.000Z",
  updatedAt: "2026-08-13T11:00:00.000Z",
};
const PUBLISHED_LEASE_AS_READ: SandboxGpuLeaseLike = PUBLISHED_LEASE;

function observedBox(overrides: Partial<SandboxInstanceLike> = {}): SandboxInstanceLike {
  return {
    id: "sbx-observed",
    status: "running",
    expiresAt: new Date("2026-08-14T00:00:00.000Z"),
    connection: PUBLISHED_CONNECTION_AS_READ,
    gpuLease: PUBLISHED_LEASE_AS_READ,
    resourceUsage: async () => PUBLISHED_USAGE_AS_READ,
    refresh: async () => undefined,
    async *streamPrompt(_message, promptOptions): AsyncIterable<SandboxEvent> {
      yield {
        type: "result",
        data: {
          finalText: "ok",
          sessionId: promptOptions?.sessionId,
          executionId: promptOptions?.executionId,
          usage: { inputTokens: 120, outputTokens: 34, costUsd: 0.0021 },
        },
      } as SandboxEvent;
    },
    ...overrides,
  };
}

function observingClient(box: SandboxInstanceLike): SandboxClientLike {
  return {
    create: async () => box,
    get: async (id) => (id === box.id ? box : null),
    describePlacement: () => ({
      kind: "sandbox",
      sandboxId: box.id,
      machineId: "machine-7",
      region: "eu-central",
    }),
    usage: async () => ({
      activeSandboxes: 3,
      periodStart: new Date("2026-08-13T00:00:00.000Z"),
      periodEnd: new Date("2026-08-14T00:00:00.000Z"),
    }),
    subscription: async () => ({
      plan: "pro",
      creditsAvailableUsd: 42.5,
      maxConcurrentSandboxes: 10,
    }),
  };
}

async function observeCreated(
  client: SandboxClientLike,
  resources?: { cpu?: number; memoryMb?: number; diskMb?: number; gpu?: string },
): Promise<{ observation: AgentEnvironmentObservation }> {
  const provider = createTangleProvider({ client });
  const environment = await provider.create({
    profile: { name: "observer" },
    ...(resources === undefined ? {} : { resources }),
  });
  if (typeof environment.observe !== "function") {
    throw new Error("the environment did not expose the observation surface");
  }
  return { observation: await environment.observe() };
}

describe("Tangle environment observation", () => {
  it("maps every surface the sandbox backs and states the rest as absent", async () => {
    const box = observedBox();
    const { observation } = await observeCreated(observingClient(box), {
      cpu: 2,
      memoryMb: 2_048,
      diskMb: 10_240,
      gpu: "nvidia-h100",
    });

    expect(AgentEnvironmentObservationSchema.safeParse(observation).success).toBe(true);
    expect(observation.subject).toEqual({
      provider: "tangle-sandbox",
      environmentId: "sbx-observed",
      backend: "opencode",
    });
    expect(observation.identity).toMatchObject({
      state: "known",
      value: observation.subject,
      provenance: { origin: "reported", source: "sandbox-instance" },
    });
    expect(observation.lifecycle).toMatchObject({
      state: "known",
      value: {
        status: "running",
        cleanup: { policy: "scheduled", scheduledAt: "2026-08-14T00:00:00.000Z" },
      },
    });
    expect(observation.endpoint).toMatchObject({
      state: "known",
      value: { scheme: "https", host: "runtime.example", port: 8443 },
    });
    expect(observation.placement?.verified).toMatchObject({
      state: "known",
      value: {
        kind: "sandbox",
        sandboxId: "sbx-observed",
        machineId: "machine-7",
        region: "eu-central",
      },
    });
    // Requested and effective are separate answers: the request is what the
    // caller asked for, the effective profile is what the runtime reports.
    expect(observation.resources?.requested).toEqual({
      cpu: 2,
      memoryMb: 2_048,
      diskMb: 10_240,
      accelerator: { kind: "nvidia-h100", count: 1 },
    });
    expect(observation.resources?.effective).toMatchObject({
      state: "known",
      value: {
        memoryMb: 4_096,
        accelerator: { kind: "nvidia-h100", count: 2, memoryMb: 81_920 },
      },
      provenance: { origin: "measured", source: "sandbox-cgroup" },
    });
    expect(observation.resourceUse?.current).toMatchObject({
      state: "known",
      value: { memoryMb: 512 },
      provenance: { origin: "measured", observedAt: "2026-08-13T12:00:00.000Z" },
    });
    expect(observation.resourceUse?.peak).toMatchObject({
      state: "known",
      value: { memoryMb: 900 },
    });
    expect(observation.computeBilling).toMatchObject({
      state: "known",
      value: { amount: 4.25, currency: "USD" },
      provenance: { origin: "estimated", source: "sandbox-gpu-lease" },
    });
    expect(observation.accountUsage?.plan).toMatchObject({
      state: "known",
      value: "pro",
    });
    expect(observation.accountUsage?.credits).toMatchObject({
      state: "known",
      value: { remaining: 42.5, unit: "USD" },
    });
    expect(observation.accountUsage?.quota).toMatchObject({
      state: "known",
      value: { limit: 10, used: 3, remaining: 7, unit: "sandboxes" },
    });
    expect(observation.accountUsage?.period).toMatchObject({
      state: "known",
      value: {
        start: "2026-08-13T00:00:00.000Z",
        end: "2026-08-14T00:00:00.000Z",
      },
    });
    // Sandbox measures usage on an execution result, so an environment that
    // has run nothing states the surface as absent rather than as zero usage.
    expect(observation.modelUsage).toEqual({
      state: "unavailable",
      reason: "no execution measured token usage through this environment handle",
    });
  });

  it("reports the freshness state for every surface the sandbox cannot back", async () => {
    const bare: SandboxInstanceLike = {
      id: "sbx-bare",
      status: "provisioning",
      async *streamPrompt() {},
    };
    const { observation } = await observeCreated({ create: async () => bare });

    expect(AgentEnvironmentObservationSchema.safeParse(observation).success).toBe(true);
    // A surface with no source keeps its discriminator and carries no value,
    // so a caller can never read an absent measurement as a measured zero.
    for (const absent of [
      observation.endpoint,
      observation.placement?.verified,
      observation.resources?.effective,
      observation.resourceUse?.current,
      observation.resourceUse?.peak,
      observation.modelUsage,
      observation.computeBilling,
      observation.accountUsage?.plan,
      observation.accountUsage?.credits,
      observation.accountUsage?.quota,
      observation.accountUsage?.period,
    ]) {
      expect(absent?.state).toBe("unavailable");
      expect(absent).not.toHaveProperty("value");
      expect((absent as { reason: string }).reason.length).toBeGreaterThan(0);
    }
    expect(observation.resources?.requested).toBeUndefined();
    // The identity and the status are readable from the instance alone, so
    // they stay known even on a sandbox that reports nothing else.
    expect(observation.identity?.state).toBe("known");
    expect(observation.lifecycle).toMatchObject({
      state: "stale",
      value: { status: "provisioning" },
      reason: "the Sandbox client cannot refresh this environment",
    });
  });

  it("keeps a credential out of the endpoint payload", async () => {
    // The schema refuses a credential structurally, in both the shapes a
    // careless mapping would produce.
    expect(
      SafeEndpointSchema.safeParse({ host: "agent:hunter2@runtime.example" }).success,
    ).toBe(false);
    expect(
      SafeEndpointSchema.safeParse({ scheme: "https://", host: "runtime.example" })
        .success,
    ).toBe(false);
    expect(
      SafeEndpointSchema.safeParse({ host: "runtime.example", token: "sbx-bearer" })
        .success,
    ).toBe(false);
    expect(
      SafeEndpointSchema.safeParse({ host: "runtime.example", authToken: "sbx" })
        .success,
    ).toBe(false);

    const box = observedBox({
      connection: {
        runtimeUrl: "https://agent:hunter2@runtime.example:8443/v1?token=sbx-bearer",
      },
    });
    const { observation } = await observeCreated(observingClient(box));

    expect(observation.endpoint).toMatchObject({
      state: "known",
      value: { scheme: "https", host: "runtime.example", port: 8443 },
    });
    expect(observationContainsCredential(observation)).toBe(false);
    expect(JSON.stringify(observation)).not.toContain("hunter2");
    expect(JSON.stringify(observation)).not.toContain("sbx-bearer");
  });

  it("claims an observation surface only where a source backs it", async () => {
    const backed = await createTangleProvider({
      client: observingClient(observedBox()),
    }).create({ profile: { name: "observer" }, resources: { cpu: 1 } });
    expect(backed.capabilities?.observation).toEqual({
      identity: true,
      lifecycle: true,
      endpoint: true,
      placement: true,
      resources: true,
      resourceUse: true,
      modelUsage: true,
      computeBilling: true,
      accountUsage: true,
    });

    const bare = await createTangleProvider({
      client: {
        create: async (): Promise<SandboxInstanceLike> => ({
          id: "sbx-unbacked",
          status: "running",
          async *streamPrompt() {},
        }),
      },
    }).create({ profile: { name: "observer" } });
    expect(bare.capabilities?.observation).toEqual({
      identity: true,
      lifecycle: true,
      endpoint: false,
      placement: false,
      resources: false,
      resourceUse: false,
      modelUsage: true,
      computeBilling: false,
      accountUsage: false,
    });
  });

  it("reports the usage of the execution the handle measured", async () => {
    const box = observedBox();
    const provider = createTangleProvider({ client: observingClient(box) });
    const environment = await provider.create({ profile: { name: "observer" } });
    for await (const event of environment.stream({
      prompt: "run",
      sessionId: "session-1",
      executionId: "execution-1",
    })) {
      expect(event.usage).toEqual({
        inputTokens: 120,
        outputTokens: 34,
        cost: 0.0021,
      });
    }

    const observation = await environment.observe!();
    expect(observation.modelUsage).toMatchObject({
      state: "known",
      value: { inputTokens: 120, outputTokens: 34, cost: 0.0021 },
      // The execution names itself, because Sandbox measures usage per
      // execution and never for the environment.
      provenance: { origin: "reported", source: "execution-1" },
    });
  });

  it("refuses to state a negative credit balance or an absent quota as a number", async () => {
    const box = observedBox();
    const client: SandboxClientLike = {
      ...observingClient(box),
      subscription: async () => ({
        plan: "enterprise",
        creditsAvailableUsd: -12.75,
        maxConcurrentSandboxes: 0,
      }),
    };
    const { observation } = await observeCreated(client);

    expect(observation.accountUsage?.credits).toEqual({
      state: "unavailable",
      reason: "the account credit balance is negative under an overage plan",
    });
    expect(observation.accountUsage?.quota).toEqual({
      state: "unavailable",
      reason: "the account states no concurrent sandbox limit",
    });
  });

  it("carries the transport failure into the surface it degraded", async () => {
    const box = observedBox({
      refresh: async () => {
        throw new Error("runtime lookup timed out");
      },
      resourceUsage: async () => {
        throw new Error("cgroup read failed");
      },
    });
    const client: SandboxClientLike = {
      ...observingClient(box),
      describePlacement: () => {
        throw new Error("placement service unreachable");
      },
      usage: async () => {
        throw new Error("usage service unreachable");
      },
    };
    const { observation } = await observeCreated(client);

    expect(observation.lifecycle).toMatchObject({
      state: "stale",
      reason: "runtime lookup timed out",
    });
    expect(observation.endpoint).toMatchObject({
      state: "stale",
      reason: "runtime lookup timed out",
    });
    expect(observation.placement?.verified).toEqual({
      state: "unavailable",
      reason: "placement service unreachable",
    });
    expect(observation.resourceUse?.current).toEqual({
      state: "unavailable",
      reason: "cgroup read failed",
    });
    expect(observation.accountUsage?.period).toEqual({
      state: "unavailable",
      reason: "usage service unreachable",
    });
    // A subscription that answered still reports its own surfaces.
    expect(observation.accountUsage?.plan).toMatchObject({ state: "known" });
  });

  it("binds a live observation to its replay by the same subject", async () => {
    const provider = createTangleProvider({ client: observingClient(observedBox()) });
    const environment = await provider.create({ profile: { name: "observer" } });
    const live = await environment.observe!();
    const replay = await environment.observe!();

    expect(agentEnvironmentObservationIdentityMatches(live, replay)).toBe(true);
    expect(
      agentEnvironmentObservationIdentityMatches(live, {
        ...replay,
        subject: { ...replay.subject, environmentId: "sbx-other" },
      }),
    ).toBe(false);
  });

  it("sends the compute shape Sandbox actually reads", () => {
    // The two shapes name the same quantities differently. A request passed
    // through unchanged reaches the service as unknown fields, so the sandbox
    // is provisioned at a size the caller never asked for.
    expect(
      sandboxOptionsFromCreateInput(
        {
          profile: { name: "worker" },
          resources: { cpu: 2, memoryMb: 2_048, diskMb: 10_240, gpu: "nvidia-h100" },
        },
        "opencode",
      ).resources,
    ).toEqual({
      cpuCores: 2,
      memoryMB: 2_048,
      diskGB: 10,
      accelerator: { kind: "nvidia-h100", count: 1 },
    });
    expect(
      sandboxOptionsFromCreateInput({ profile: { name: "worker" } }, "opencode").resources,
    ).toBeUndefined();
    expect(() =>
      sandboxOptionsFromCreateInput(
        { profile: { name: "worker" }, resources: { diskMb: 1_500 } },
        "opencode",
      ),
    ).toThrow(/whole number of gibibytes/);
    expect(() =>
      sandboxOptionsFromCreateInput(
        { profile: { name: "worker" }, resources: { cpu: 0 } },
        "opencode",
      ),
    ).toThrow(/positive safe integer/);
    expect(requestedResourceProfile(undefined)).toBeUndefined();
    expect(requestedResourceProfile({})).toBeUndefined();
  });
});

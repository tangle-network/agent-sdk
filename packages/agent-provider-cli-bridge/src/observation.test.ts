import { describe, expect, it } from "vitest";
import {
  AgentEnvironmentObservationSchema,
  observationContainsCredential,
} from "@tangle-network/agent-interface";
import type { AgentEnvironment } from "@tangle-network/agent-interface/environment-provider";
import { createCliBridgeProvider, defaultCliBridgeCapabilities } from "./index.js";

function usageStreamProvider(baseUrl: string, bearerToken?: string) {
  return createCliBridgeProvider({
    baseUrl,
    ...(bearerToken === undefined ? {} : { bearerToken }),
    fetch: async () =>
      new Response(
        [
          'data: {"choices":[{"delta":{"content":"partial"}}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14,"cost":0.01}}\n\n',
          'data: {"choices":[{"delta":{"content":" done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7,"cost":0.02}}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  });
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    // Drain the stream to its terminal condition.
  }
}

describe("cli-bridge environment observation", () => {
  it("reports the bridge endpoint and identity it can prove", async () => {
    const provider = usageStreamProvider("https://bridge.example:8443/v1");
    const environment = await provider.create({ profile: { name: "worker" } });
    const observation = await environment.observe!();

    expect(AgentEnvironmentObservationSchema.safeParse(observation).success).toBe(true);
    expect(observation.subject).toEqual({
      provider: "cli-bridge",
      environmentId: expect.any(String),
    });
    expect(observation.identity).toMatchObject({ state: "known", value: observation.subject });
    expect(observation.endpoint).toMatchObject({
      state: "known",
      value: { scheme: "https", host: "bridge.example", port: 8443 },
    });
  });

  it("reports configuration as the request it is, never as a verified fact", async () => {
    const provider = usageStreamProvider("https://bridge.example/v1");
    const environment = await provider.create({ profile: { name: "worker" } });
    const observation = await environment.observe!();

    // The configured execution kind is what the caller asked for. cli-bridge
    // runs no placement check and never probes the bridge, so neither the
    // placement nor the lifecycle is carried as a proven value.
    expect(observation.placement?.requested).toEqual({ kind: "local" });
    expect(observation.placement?.verified).toEqual({
      state: "unavailable",
      reason: "cli-bridge never probes the bridge, so its runtime state is unproven",
    });
    expect(observation.lifecycle).toEqual({
      state: "unavailable",
      reason: "cli-bridge never probes the bridge, so its runtime state is unproven",
    });
    expect(observation.placement?.verified).not.toHaveProperty("value");
    expect(observation.lifecycle).not.toHaveProperty("value");
  });

  it("states every surface the bridge cannot back rather than a measured zero", async () => {
    const provider = usageStreamProvider("https://bridge.example/v1");
    const environment = await provider.create({ profile: { name: "worker" } });
    const observation = await environment.observe!();

    for (const absent of [
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
    }
    // cli-bridge never transmits a resource request, so it never restates one.
    expect(observation.resources?.requested).toBeUndefined();
  });

  it("sums the usage of the execution the handle measured", async () => {
    const provider = usageStreamProvider("https://bridge.example/v1", "bridge-bearer");
    const environment = await provider.create({ profile: { name: "worker" } });
    await drain(
      environment.stream({
        prompt: "run",
        model: "glm-5.2",
        sessionId: "session-1",
        turnId: "turn-1",
        executionId: "execution-1",
      }),
    );
    const observation = await environment.observe!();

    expect(observation.modelUsage).toMatchObject({
      state: "known",
      value: { inputTokens: 15, outputTokens: 6, totalTokens: 21, cost: 0.03 },
      // The execution names itself, because cli-bridge measures usage per run
      // and never for the environment.
      provenance: { origin: "reported", source: "execution-1" },
    });
    expect(observationContainsCredential(observation)).toBe(false);
    expect(JSON.stringify(observation)).not.toContain("bridge-bearer");
  });

  it("reports a stopped lifecycle after the environment is destroyed", async () => {
    const provider = usageStreamProvider("https://bridge.example/v1");
    const environment: AgentEnvironment = await provider.create({
      profile: { name: "worker" },
    });
    await environment.destroy!();

    // The adapter performed the destroy, so this is the one lifecycle fact it
    // establishes without probing the bridge.
    await expect(environment.observe!()).resolves.toMatchObject({
      lifecycle: { state: "known", value: { status: "stopped" } },
    });
  });

  it("clears every surface a caller's document claims that the bridge cannot back", async () => {
    // A caller can supply the capability document, so the narrowing is proved
    // against one that claims every surface. The bridge provisions no compute
    // and holds no account, so those claims must not survive.
    const overclaiming = defaultCliBridgeCapabilities();
    const provider = createCliBridgeProvider({
      baseUrl: "https://bridge.example/v1",
      capabilities: {
        ...overclaiming,
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
      },
      fetch: async () => new Response(null, { status: 500 }),
    });

    expect((await provider.capabilities()).observation).toEqual({
      identity: true,
      lifecycle: true,
      endpoint: true,
      placement: true,
      resources: false,
      resourceUse: false,
      modelUsage: true,
      computeBilling: false,
      accountUsage: false,
    });
    // The observation the environment produces agrees with the narrowed
    // document: a surface the caller claimed carries its reason, not a value.
    const environment = await provider.create({ profile: { name: "worker" } });
    const observation = await environment.observe!();
    for (const absent of [
      observation.resources?.effective,
      observation.resourceUse?.current,
      observation.resourceUse?.peak,
      observation.computeBilling,
      observation.accountUsage?.plan,
    ]) {
      expect(absent?.state).toBe("unavailable");
      expect(absent).not.toHaveProperty("value");
    }
  });

  it("claims an observation surface only where the bridge backs it", async () => {
    const declared = defaultCliBridgeCapabilities();
    expect(declared.observation).toEqual({
      identity: true,
      lifecycle: true,
      endpoint: true,
      placement: true,
      resources: false,
      resourceUse: false,
      modelUsage: true,
      computeBilling: false,
      accountUsage: false,
    });

    // A base URL that states no reachable host cannot back the endpoint, even
    // when the caller's document claims it, and the observation then carries
    // the surface with its reason.
    const unreachable = createCliBridgeProvider({
      baseUrl: "not-a-url",
      capabilities: {
        ...declared,
        observation: { ...declared.observation!, endpoint: true },
      },
      fetch: async () => new Response(null, { status: 500 }),
    });
    const document = await unreachable.capabilities();
    expect(document.observation?.endpoint).toBe(false);
    const environment = await unreachable.create({ profile: { name: "worker" } });
    await expect(environment.observe!()).resolves.toMatchObject({
      endpoint: {
        state: "unavailable",
        reason: "the cli-bridge base URL states no reachable host",
      },
    });
  });

  it("exposes no observation method when the document claims none", async () => {
    const { observation: _dropped, ...withoutObservation } =
      defaultCliBridgeCapabilities();
    const provider = createCliBridgeProvider({
      baseUrl: "https://bridge.example/v1",
      capabilities: withoutObservation,
      fetch: async () => new Response(null, { status: 500 }),
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    expect((await provider.capabilities()).observation).toBeUndefined();
    expect(environment.observe).toBeUndefined();
  });
});

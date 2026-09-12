import type { CreateSandboxOptions } from "@tangle-network/sandbox";
import { agentProfileSchema } from "@tangle-network/agent-interface";
import { describe, expect, it } from "vitest";
import { createTangleProvider, type SandboxInstanceLike, type TangleProviderOptions } from "./index.js";

const modelCredentials = {
  apiKeyEnv: "RESEARCH_ROUTER_KEY",
  baseUrl: "https://router.tangle.tools/v1",
};

function capturingClient() {
  const creates: CreateSandboxOptions[] = [];
  const box: SandboxInstanceLike = {
    id: "sandbox-model-credentials",
    status: "running",
    async *streamPrompt() {},
  };
  return {
    creates,
    client: {
      async create(options?: CreateSandboxOptions) {
        creates.push(options ?? {});
        return box;
      },
    },
  };
}

describe("Tangle create-time named model credentials", () => {
  it("forwards the explicit reference and endpoint on public provider.create", async () => {
    const { client, creates } = capturingClient();
    const options = { client, modelCredentials };
    const provider = createTangleProvider(options);
    const profile = { name: "researcher", harness: "opencode" as const };

    await provider.create({ profile, secrets: [modelCredentials.apiKeyEnv] });

    expect(creates[0]?.backend).toEqual({
      type: "opencode",
      profile,
      model: modelCredentials,
    });
    expect(creates[0]?.secrets).toEqual([modelCredentials.apiKeyEnv]);
  });

  it("leaves managed creation unchanged when configuration is omitted", async () => {
    const { client, creates } = capturingClient();
    const profile = { name: "researcher", harness: "opencode" as const };
    await createTangleProvider({ client }).create({ profile });
    expect(creates).toEqual([{ backend: { type: "opencode", profile } }]);
  });

  it("preserves profile selection, placement, identity, and the explicit secret grant", async () => {
    const { client, creates } = capturingClient();
    const profile = agentProfileSchema.parse({
      name: "researcher", harness: "opencode" as const,
      model: { provider: "openai-compat", default: "deepseek-v4.1-flash" },
    });
    const input = {
      profile, name: "bounded-research",
      secrets: [modelCredentials.apiKeyEnv, "COORDINATION_TOKEN"],
      idempotencyKey: "research-attempt-1", billingOwner: "usr_research",
      egress: { mode: "strict" as const, allowDomains: ["router.tangle.tools"] },
      workspace: { image: "research-image", cwd: { base: "repository" as const, path: "work" } },
      resources: { cpu: 2, memoryMb: 2048, diskMb: 4096 },
      env: { RESEARCH_ID: "attempt-1" }, metadata: { pursuit: "research" },
    };
    const managed = capturingClient();
    await createTangleProvider({ client: managed.client }).create(input);
    const provider = createTangleProvider({ client, modelCredentials });
    await provider.create(input);
    await provider.create(input);
    expect(creates).toHaveLength(1);
    expect(creates[0]).toEqual({
      ...managed.creates[0],
      backend: { ...managed.creates[0]?.backend, model: modelCredentials },
    });
    expect(creates[0]?.backend?.profile).toEqual(profile);
  });

  it("snapshots configuration at provider intake", async () => {
    const { client, creates } = capturingClient();
    const configured = { ...modelCredentials };
    const options: TangleProviderOptions = { client, modelCredentials: configured };
    const provider = createTangleProvider(options);
    configured.apiKeyEnv = "REPLACED_KEY";
    configured.baseUrl = "https://other.example/v1";
    options.modelCredentials = { ...configured };
    options.mapCreateInput = () => ({ backend: { type: "opencode" } });
    await provider.create({ profile: { name: "worker" }, secrets: [modelCredentials.apiKeyEnv] });
    expect(creates[0]?.backend?.model).toEqual(modelCredentials);
  });

  it.each([undefined, [], ["OTHER_KEY"]])("refuses a missing explicit grant (%j) before provisioning", async (secrets) => {
    const { client, creates } = capturingClient();
    const provider = createTangleProvider({ client, modelCredentials });
    await expect(provider.create({ profile: { name: "worker" }, ...(secrets ? { secrets } : {}) }))
      .rejects.toThrow(/explicitly listed in create secrets/);
    expect(creates).toHaveLength(0);
  });

  it.each(["", "lowercase", "1KEY", "KEY-NAME", "KEY NAME", "A".repeat(129)])(
    "refuses an invalid credential name (%s)", (apiKeyEnv) => {
      const { client, creates } = capturingClient();
      expect(() => createTangleProvider({ client, modelCredentials: { ...modelCredentials, apiKeyEnv } }))
        .toThrow(/stored secret name/);
      expect(creates).toHaveLength(0);
    },
  );

  it.each([
    "", "not-a-url", "file:///tmp/router", "https://user:password@router.example/v1",
    "https://router.example/v1?api_key=value", "https://router.example/v1#token",
    " https://router.example/v1", `https://router.example/${"a".repeat(2048)}`,
  ])("refuses an invalid or credential-bearing endpoint (%s)", (baseUrl) => {
    const { client, creates } = capturingClient();
    expect(() => createTangleProvider({ client, modelCredentials: { ...modelCredentials, baseUrl } }))
      .toThrow(/HTTP\(S\) endpoint/);
    expect(creates).toHaveLength(0);
  });

  it.each([
    null, [], {}, { apiKeyEnv: modelCredentials.apiKeyEnv },
    { ...modelCredentials, apiKey: "fixture-not-a-secret" },
    { ...modelCredentials, authFiles: [] },
    { ...modelCredentials, provider: "other-provider" },
  ])("refuses unsupported configuration (%j)", (value) => {
    const { client, creates } = capturingClient();
    expect(() => createTangleProvider({ client, modelCredentials: value as never })).toThrow();
    expect(creates).toHaveLength(0);
  });

  it("refuses ambiguous custom mapper ownership", () => {
    const { client, creates } = capturingClient();
    expect(() => createTangleProvider({ client, modelCredentials, mapCreateInput: () => ({}) }))
      .toThrow(/cannot be combined with mapCreateInput/);
    expect(creates).toHaveLength(0);
  });
});

import { describe, expect, it, vi } from "vitest";
import { createTangleProvider } from "./index.js";
import type { ProxySecretCapabilities, ProxySecretReceipt } from "@tangle-network/agent-interface/environment-provider";
import type { SandboxClientLike } from "./tangle-types.js";

const binding = {
  envName: "REPORTS_TOKEN",
  secretRef: { kind: "secret-ref" as const, key: "reports-access" },
  hosts: ["reports.example.com"], presentation: { type: "bearer" as const },
  methods: ["POST"], paths: ["/v1/events"], ttlSeconds: 300,
};
const profile = { name: "secure-reporter", harness: "opencode" as const, proxySecrets: [binding] };
const capability: ProxySecretCapabilities = {
  protocolVersion: 1 as const, supportedDrivers: ["docker"], placementReceiptRequired: true as const, presentations: ["bearer" as const],
  placeholderFormats: ["opaque" as const], enforcement: "exact" as const,
  transports: ["https:443" as const], lifecycle: true as const,
};
function setup() {
  const creates: unknown[] = [];
  const turns = vi.fn();
  let metadata: Record<string, unknown> | undefined;
  let receipt: ProxySecretReceipt = {
    protocolVersion: 1, sandboxId: "proxy-box", generation: 1, status: "installed",
    proxyAcknowledged: true, materializationAcknowledged: true,
    bindings: [{ envName: binding.envName, secretRef: { ...binding.secretRef }, grant: {
      protocolVersion: 1, grantId: "grant-1", sandboxId: "proxy-box", epoch: "epoch-1",
      identity: { tenantId: "tenant-1", issuerId: "issuer-1", secretId: "secret-1", revision: "rev-1" },
      scope: { hosts: ["reports.example.com"], methods: ["POST"], paths: ["/v1/events"] },
      presentation: { type: "bearer" }, placeholderFormat: "opaque",
      issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 290_000).toISOString(),
    } }],
  };
  const grants = vi.fn(async () => ({ proxySecretReceipt: receipt }));
  const box = {
    id: "proxy-box", status: "running", get metadata() { return metadata; },
    capabilities: async () => ({ proxySecrets: capability }),
    backend: { status: async () => ({ type: "codex" }) },
    grantNativeCredential: grants,
    egress: {
      get: async () => ({ proxySecretReceipt: receipt }),
      update: async () => ({ proxySecretReceipt: receipt }),
    },
    async *streamPrompt() { turns(); },
  };
  const client = {
    capabilities: async () => ({ proxySecrets: capability }),
    async create(options?: Parameters<SandboxClientLike["create"]>[0]) { creates.push(options); metadata = options?.metadata; return box; },
    async get() { return box; },
  };
  return { client, creates, turns, box, grants, get receipt() { return receipt; }, set receipt(value: ProxySecretReceipt) { receipt = value; } };
}

describe("public provider proxy-secret custody", () => {
  it("forwards one canonical profile declaration without readable grants", async () => {
    const { client, creates } = setup();
    const environment = await createTangleProvider({ client }).create({ profile, secrets: [] });
    expect(environment.proxySecretReceipt?.status).toBe("installed");
    expect(creates[0]).toMatchObject({ proxySecrets: [binding], secrets: [], backend: { profile } });
  });

  it("refuses an old peer before subscription resolution or allocation", async () => {
    const { client, creates } = setup();
    const resolver = vi.fn(async () => ({ cliAuth: { account: "seat", secretEnv: "NATIVE_BUNDLE", format: "bundle" as const }, proxySecrets: [binding] }));
    const native = { ...profile, harness: "codex" as const, model: { metadata: { credentialSource: "subscription" } } };
    await expect(createTangleProvider({ client: { ...client, capabilities: undefined }, modelCredentials: resolver }).create({ profile: native }))
      .rejects.toThrow(/proxy.secret.*capabilit/i);
    expect(resolver).not.toHaveBeenCalled();
    expect(creates).toEqual([]);
  });

  it("rejects input/profile disagreement and raw aliases before allocation", async () => {
    const { client, creates } = setup();
    const provider = createTangleProvider({ client });
    await expect(provider.create({ profile, proxySecrets: [{ ...binding, hosts: ["other.example.com"] }] })).rejects.toThrow(/proxy.secret.*(differ|disagree)/i);
    await expect(provider.create({ profile, env: { REPORTS_TOKEN: "fixture" } })).rejects.toThrow(/proxy.secret.*(raw|readable|alias|shadow)/i);
    await expect(provider.create({ profile, secrets: ["reports-access"] })).rejects.toThrow(/proxy.secret.*(raw|readable|alias|shadow)/i);
    expect(creates).toEqual([]);
  });
  it("retains authenticated runtime attachment references with the same proxy declaration", async () => {
    const fixture = setup();
    const runtimeAttachments = { mcp: { reports: { transport: "http" as const, url: "https://reports.example.com/v1/events",
      headers: { Authorization: { ...binding.secretRef, format: "bearer" as const } } } } };
    const getBackend = async () => ({
      type: "opencode", name: "OpenCode", description: "fixture",
      capabilities: { streaming: true, toolUse: true, reasoning: true, multimodal: false, imageInput: false,
        contextWindow: 128000, mcp: true, sessions: true, configurable: true, interactions: [], runtimeAttachments: { mcp: true } },
    });
    await createTangleProvider({ client: { ...fixture.client, getBackend } }).create({ profile, runtimeAttachments });
    expect(fixture.creates[0]).toMatchObject({ proxySecrets: [binding], secrets: [], backend: { runtimeAttachments } });
  });

  it("refuses a mapper dropping proxy custody before allocation", async () => {
    const fixture = setup();
    const provider = createTangleProvider({ client: fixture.client, mapCreateInput: () => ({ backend: { type: "opencode", profile } }) });
    await expect(provider.create({ profile })).rejects.toThrow(/mapped proxy.secret.*differ/i);
    expect(fixture.creates).toEqual([]);
  });

  it.each(["sandbox", "scope", "expiry", "phase", "reference"] as const)("rejects an invalid installed receipt at create (%s)", async (fault) => {
    const fixture = setup();
    if (fault === "sandbox") fixture.receipt = { ...fixture.receipt, sandboxId: "other-box" };
    if (fault === "reference") fixture.receipt.bindings[0]!.secretRef.key = "different-secret";
    if (fault === "scope") fixture.receipt.bindings[0]!.grant.scope.hosts = ["attacker.example.com"];
    if (fault === "expiry") fixture.receipt.bindings[0]!.grant.expiresAt = new Date(Date.now() - 500).toISOString();
    if (fault === "phase") fixture.receipt = { ...fixture.receipt, status: "proxy-installed", materializationAcknowledged: false };
    await expect(createTangleProvider({ client: fixture.client }).create({ profile })).rejects.toThrow();
    expect(fixture.turns).not.toHaveBeenCalled();
  });

  it("rechecks live revocation before both reconnect and retained dispatch", async () => {
    const fixture = setup();
    const provider = createTangleProvider({ client: fixture.client });
    const environment = await provider.create({ profile });
    const recovered = await provider.get?.(environment.id);
    expect(recovered?.proxySecretReceipt?.generation).toBe(1);
    fixture.receipt = { ...fixture.receipt, generation: 2, status: "revoked", bindings: [] };
    await expect(provider.get?.(environment.id)).rejects.toThrow(/custody/);
    await expect((async () => { for await (const _event of environment.stream({ prompt: "send report" })) {} })()).rejects.toThrow(/custody/);
    expect(fixture.turns).not.toHaveBeenCalled();
  });

  it("forwards immutable native resolver references through create and renews proxy custody before a fresh turn", async () => {
    const fixture = setup();
    fixture.box.capabilities = async () => ({ proxySecrets: capability, cliAuthReferences: true, codexCredentialContinuations: true });
    const nativeProfile = { ...profile, harness: "codex" as const, model: { metadata: { credentialSource: "subscription" } } };
    const selected = structuredClone({ cliAuth: { account: "seat", secretEnv: "NATIVE_BUNDLE", format: "bundle" as const }, proxySecrets: [binding] });
    const resolver = vi.fn(async () => selected);
    const provider = createTangleProvider({ client: fixture.client, modelCredentials: resolver });
    const environment = await provider.create({ profile: nativeProfile });
    const serialized = JSON.stringify(fixture.creates[0]);
    expect(fixture.creates[0]).toMatchObject({ proxySecrets: [binding], secrets: ["NATIVE_BUNDLE"],
      backend: { model: { cliAuth: selected.cliAuth, authMode: "oauth" } } });
    expect(serialized).not.toContain('"secrets":["reports-access"');
    for await (const _event of environment.stream({ prompt: "report", profile: nativeProfile, turnId: "turn-1" })) {}
    expect(fixture.grants).toHaveBeenCalledWith(expect.objectContaining({
      cliAuth: selected.cliAuth, proxySecrets: [binding], expectedProxySecretGeneration: 1, requireInPlace: true,
    }), undefined);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(fixture.turns).toHaveBeenCalledTimes(1);
    selected.proxySecrets[0]!.hosts = ["mutated.example.com"];
    expect(fixture.creates[0]).toMatchObject({ proxySecrets: [{ hosts: ["reports.example.com"] }] });
  });
  it("recovers an expired native lease through its trusted resolver and requires fresh custody before dispatch", async () => {
    const fixture = setup();
    fixture.box.capabilities = async () => ({ proxySecrets: capability, cliAuthReferences: true, codexCredentialContinuations: true });
    const nativeProfile = { ...profile, harness: "codex" as const, model: { metadata: { credentialSource: "subscription" } } };
    const selected = { cliAuth: { account: "seat", secretEnv: "NATIVE_BUNDLE", format: "bundle" as const }, proxySecrets: [binding] };
    let selection = 0;
    const provider = createTangleProvider({ client: fixture.client, modelCredentials: async () => {
      if (++selection > 1) {
        fixture.receipt = { ...fixture.receipt, generation: 2, bindings: fixture.receipt.bindings.map((row) => ({
          ...row, grant: { ...row.grant, issuedAt: new Date(Date.now() - 100).toISOString(), expiresAt: new Date(Date.now() + 299_000).toISOString() },
        })) };
      }
      return selected;
    } });
    const created = await provider.create({ profile: nativeProfile });
    fixture.receipt.bindings[0]!.grant.issuedAt = new Date(Date.now() - 300_000).toISOString();
    fixture.receipt.bindings[0]!.grant.expiresAt = new Date(Date.now() - 1).toISOString();
    const recovered = await provider.get?.(created.id);
    if (!recovered) throw new Error("Expected native reconnect handle");
    for await (const _event of recovered.stream({ prompt: "continue", profile: nativeProfile, turnId: "turn-renew" })) {}
    expect(recovered.proxySecretReceipt?.generation).toBe(2);
    expect(fixture.turns).toHaveBeenCalledTimes(1);
    fixture.grants.mockRejectedValueOnce(new Error("trusted renewal refused"));
    await expect((async () => {
      for await (const _event of recovered.stream({ prompt: "again", profile: nativeProfile, turnId: "turn-fail" })) {}
    })()).rejects.toThrow(/trusted renewal refused/);
    expect(fixture.turns).toHaveBeenCalledTimes(1);
  });

  it("refuses resolver output containing credential values before allocation", async () => {
    const fixture = setup();
    const nativeProfile = { ...profile, harness: "codex" as const, model: { metadata: { credentialSource: "subscription" } } };
    const malicious = { cliAuth: { account: "seat", secretEnv: "NATIVE_BUNDLE", format: "bundle" }, proxySecrets: [{ ...binding, value: "fixture-private-value" }] };
    await expect(createTangleProvider({ client: fixture.client, modelCredentials: async () => malicious as never }).create({ profile: nativeProfile })).rejects.toThrow();
    expect(fixture.creates).toEqual([]);
  });

  it("retains resolver-owned native bindings separately from the exact authored profile", async () => {
    const fixture = setup();
    fixture.box.capabilities = async () => ({ proxySecrets: capability, cliAuthReferences: true, codexCredentialContinuations: true });
    const nativeProfile = { name: "native-reporter", harness: "codex" as const,
      model: { metadata: { credentialSource: "subscription" } }, proxySecrets: [] };
    const selected = { cliAuth: { account: "seat", secretEnv: "NATIVE_BUNDLE", format: "bundle" as const }, proxySecrets: [binding] };
    const environment = await createTangleProvider({ client: fixture.client, modelCredentials: async () => selected }).create({ profile: nativeProfile });
    for await (const _event of environment.stream({ prompt: "report", profile: nativeProfile, turnId: "profile-and-native" })) {}
    expect(fixture.grants).toHaveBeenCalledWith(expect.objectContaining({ proxySecrets: [binding] }), undefined);
    expect(fixture.turns).toHaveBeenCalledTimes(1);
  });

});

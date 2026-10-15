import { describe, expect, it, vi } from "vitest";
import { Sandbox } from "@tangle-network/sandbox";
import { createTangleProvider } from "./index.js";
import type { ProxySecretBinding, ProxySecretCapabilities, ProxySecretReceipt } from "@tangle-network/agent-interface/environment-provider";
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
  let declarations: ProxySecretBinding[] = [structuredClone(binding)];
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
      get: async (): Promise<unknown> => ({ proxySecrets: declarations, proxySecretReceipt: receipt }),
      update: async (_update?: { proxySecrets: ProxySecretBinding[]; proxySecretParents?: Record<string, string | null> }): Promise<unknown> => ({ proxySecretReceipt: receipt }),
    },
    async *streamPrompt() { turns(); },
  };
  const client = {
    capabilities: async () => ({ proxySecrets: capability }),
    async create(options?: Parameters<SandboxClientLike["create"]>[0]) { creates.push(options); metadata = options?.metadata; declarations = options?.proxySecrets === undefined ? declarations : structuredClone(options.proxySecrets); return box; },
    async get() { return box; },
  };
  return { client, creates, turns, box, grants, get declarations() { return declarations; }, set declarations(value: typeof declarations) { declarations = value; }, get receipt() { return receipt; }, set receipt(value: ProxySecretReceipt) { receipt = value; } };
}

describe("public provider proxy-secret custody", () => {
  it("accepts an actual SDK Sandbox with a nullable capability response", () => {
    const client = Object.assign(
      new Sandbox({ baseUrl: "https://sandbox.example", apiKey: "fixture-api-key" }),
      { async capabilities(): Promise<{ proxySecrets?: ProxySecretCapabilities } | null> { return null; } },
    );
    expect(createTangleProvider({ client }).name).toBe("tangle-sandbox");
  });

  it("refuses a null capability response before subscription resolution or allocation", async () => {
    const { client, creates } = setup();
    const resolver = vi.fn(async () => ({ cliAuth: { account: "seat", secretEnv: "NATIVE_BUNDLE", format: "bundle" as const }, proxySecrets: [binding] }));
    const native = { ...profile, harness: "codex" as const, model: { metadata: { credentialSource: "subscription" } } };
    await expect(createTangleProvider({
      client: { ...client, capabilities: async () => null }, modelCredentials: resolver,
    }).create({ profile: native })).rejects.toThrow(/proxy.secret.*capabilit/i);
    expect(resolver).not.toHaveBeenCalled();
    expect(creates).toEqual([]);
  });

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
        contextWindow: 128000, mcp: true, sessions: true, configurable: true, interactions: [], runtimeAttachments: { mcp: true as const } },
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
    fixture.receipt = { ...fixture.receipt, generation: 2, status: "revoked", bindings: [], materializationAcknowledged: true };
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
        fixture.receipt = { ...fixture.receipt, status: "installed", materializationAcknowledged: true, generation: 2, bindings: fixture.receipt.bindings.map((row) => ({
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

  it("combines independent profile and executor declarations without adding readable secret grants", async () => {
    const fixture = setup();
    const extra = { ...binding, envName: "COORDINATION_TOKEN", secretRef: { kind: "secret-ref" as const, key: "coordination-access" } };
    fixture.receipt.bindings.push({ ...fixture.receipt.bindings[0]!, envName: extra.envName, secretRef: extra.secretRef,
      grant: { ...fixture.receipt.bindings[0]!.grant, grantId: "grant-coordination", identity: {
        tenantId: "tenant-1", issuerId: "issuer-1", secretId: "coordination-secret", revision: "rev-1",
      } } });
    await createTangleProvider({ client: fixture.client }).create({ profile, proxySecrets: [extra] });
    expect(fixture.creates[0]).toMatchObject({ proxySecrets: [binding, extra], secrets: [] });
  });

  it("rebinds an existing environment in place using generation-bound lifecycle acknowledgements", async () => {
    const fixture = setup();
    const provider = createTangleProvider({ client: fixture.client });
    const created = await provider.create({ profile });
    const replacement = { ...binding, secretRef: { kind: "secret-ref" as const, key: "renewed-reports-access" } };
    const updates = vi.fn(async () => {
      fixture.declarations = [replacement];
      fixture.receipt = { ...fixture.receipt, status: "installed", materializationAcknowledged: true, generation: 2,
        bindings: [{ ...fixture.receipt.bindings[0]!, secretRef: replacement.secretRef }] };
      return { proxySecretReceipt: fixture.receipt };
    });
    fixture.box.egress.update = updates;
    const rebound = await provider.get?.(created.id, { proxySecrets: [replacement], expectedProxySecretGeneration: 1, requireInPlace: true });
    expect(updates).toHaveBeenCalledWith({ proxySecrets: [replacement], expectedProxySecretGeneration: 1, requireInPlace: true }, undefined);
    expect(rebound?.proxySecretReceipt?.bindings[0]?.secretRef).toEqual(replacement.secretRef);
    for await (const _event of rebound!.stream({ prompt: "send report" })) {}
    expect(fixture.turns).toHaveBeenCalledTimes(1);
    expect((await provider.get?.(created.id))?.proxySecretReceipt?.bindings[0]?.secretRef).toEqual(replacement.secretRef);
    await expect(provider.get?.(created.id, { proxySecrets: [replacement], expectedProxySecretGeneration: 1 })).rejects.toThrow(/generation/);
    expect(fixture.creates).toHaveLength(1);
  });

  it("preserves explicit empty reconnect selection and requires confirmed revocation", async () => {
    const fixture = setup();
    const provider = createTangleProvider({ client: fixture.client });
    const created = await provider.create({ profile });
    const updates = vi.fn(async () => {
      fixture.declarations = [];
      fixture.receipt = { ...fixture.receipt, status: "revoked", materializationAcknowledged: true, generation: 2, bindings: [] };
      return { proxySecretReceipt: fixture.receipt };
    });
    fixture.box.egress.update = updates;
    const revoked = await provider.get?.(created.id, { proxySecrets: [] });
    expect(updates).toHaveBeenCalledWith({ proxySecrets: [], expectedProxySecretGeneration: 1, requireInPlace: true }, undefined);
    expect(revoked?.proxySecretReceipt?.status).toBe("revoked");
    expect(fixture.creates).toHaveLength(1);
  });

  it("accepts a refreshed revision only with a newer receipt generation while pinning resolved secret identity", async () => {
    const fixture = setup();
    const environment = await createTangleProvider({ client: fixture.client }).create({ profile });
    fixture.receipt = { ...fixture.receipt, status: "installed", materializationAcknowledged: true, generation: 2,
      bindings: fixture.receipt.bindings.map((row) => ({ ...row, grant: { ...row.grant, identity: { ...row.grant.identity, revision: "rev-2" } } })) };
    for await (const _event of environment.stream({ prompt: "use refreshed source" })) {}
    expect(environment.proxySecretReceipt?.bindings[0]?.grant.identity.revision).toBe("rev-2");
    fixture.receipt.bindings[0]!.grant.identity.revision = "rev-3";
    await expect((async () => {
      for await (const _event of environment.stream({ prompt: "same-generation mutation" })) {}
    })()).rejects.toThrow(/custody|resolved identity/);
    fixture.receipt = structuredClone(environment.proxySecretReceipt!);
    fixture.receipt.bindings[0]!.grant.expiresAt = new Date(Date.parse(fixture.receipt.bindings[0]!.grant.expiresAt) + 100).toISOString();
    await expect((async () => {
      for await (const _event of environment.stream({ prompt: "same-generation lifetime mutation" })) {}
    })()).rejects.toThrow(/custody/);
    fixture.receipt = { ...fixture.receipt, status: "installed", materializationAcknowledged: true, generation: 3,
      bindings: fixture.receipt.bindings.map((row) => ({ ...row, grant: { ...row.grant, identity: { ...row.grant.identity, secretId: "other-secret" } } })) };
    await expect((async () => {
      for await (const _event of environment.stream({ prompt: "different secret" })) {}
    })()).rejects.toThrow(/custody|resolved identity/);
    expect(fixture.turns).toHaveBeenCalledTimes(1);
  });

  it("preserves the trusted source expiry ceiling for the same immutable revision across replacement grants", async () => {
    const fixture = setup();
    const grant = fixture.receipt.bindings[0]!.grant;
    grant.sourceExpiresAt = new Date(Date.parse(grant.expiresAt) + 1000).toISOString();
    const environment = await createTangleProvider({ client: fixture.client }).create({ profile });
    fixture.receipt = { ...fixture.receipt, status: "installed", materializationAcknowledged: true, generation: 2,
      bindings: fixture.receipt.bindings.map((row) => {
        const { sourceExpiresAt: _sourceExpiry, ...withoutCeiling } = row.grant;
        return { ...row, grant: withoutCeiling };
      }) };
    await expect((async () => {
      for await (const _event of environment.stream({ prompt: "drop source lifetime evidence" })) {}
    })()).rejects.toThrow(/resolved identity/);
    expect(fixture.turns).not.toHaveBeenCalled();
  });

  it("refuses an empty reconnect update that does not confirm revocation", async () => {
    const fixture = setup();
    const provider = createTangleProvider({ client: fixture.client });
    const created = await provider.create({ profile });
    fixture.box.egress.update = vi.fn(async () => {
      fixture.declarations = [];
      fixture.receipt = { ...fixture.receipt, status: "installed", materializationAcknowledged: true, generation: 2, bindings: [] };
      return { proxySecretReceipt: fixture.receipt };
    });
    await expect(provider.get?.(created.id, { proxySecrets: [] })).rejects.toThrow(/confirmed revocation/);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.turns).not.toHaveBeenCalled();
  });

});


describe("host parent selection through the public provider", () => {
  it("forwards explicit total root pins and exposes verified readback", async () => {
    const fixture = setup();
    const parents = { REPORTS_TOKEN: null };
    fixture.client.capabilities = async () => ({ proxySecrets: capability, proxySecretDelegation: 1 });
    fixture.box.capabilities = async () => ({ proxySecrets: capability, proxySecretDelegation: 1 });
    fixture.box.egress.get = async () => ({ proxySecrets: fixture.declarations, proxySecretReceipt: fixture.receipt, proxySecretParents: parents });
    const input = { profile, proxySecretParents: parents };
    const environment = await createTangleProvider({ client: fixture.client }).create(input);
    expect(fixture.creates[0]).toMatchObject({ proxySecretParents: parents });
    expect(environment).toHaveProperty("proxySecretParents", parents);
    expect((await createTangleProvider({ client: fixture.client }).get?.(environment.id))).toHaveProperty("proxySecretParents", parents);
  });

  it("requires the API marker before mapped create allocation", async () => {
    const fixture = setup();
    const input = { profile, proxySecretParents: { REPORTS_TOKEN: null } };
    await expect(createTangleProvider({ client: fixture.client }).create(input)).rejects.toThrow(/delegation.*capabilit/i);
    expect(fixture.creates).toHaveLength(0);
  });

  it("rejects delegated grants without total parent readback", async () => {
    const fixture = setup();
    fixture.receipt.bindings[0]!.grant.parentGrantId = "parent-grant";
    await expect(createTangleProvider({ client: fixture.client }).create({ profile })).rejects.toThrow(/parent.*(map|readback)/i);
  });

  it("requires the API marker for observed maps on ordinary recovery", async () => {
    const fixture = setup();
    fixture.box.egress.get = async () => ({ proxySecrets: fixture.declarations, proxySecretReceipt: fixture.receipt, proxySecretParents: { REPORTS_TOKEN: null } });
    await expect(createTangleProvider({ client: fixture.client }).get?.("proxy-box")).rejects.toThrow(/delegation.*capabilit/i);
  });
});


describe("mapped mixed authority and immutable parent pins", () => {
  function mapped() {
    const fixture = setup();
    const inherited = { ...binding, envName: "RENAMED_TOKEN" };
    const coord = { ...binding, envName: "COORD", secretRef: { kind: "secret-ref" as const, key: "fresh-coordination" } };
    const parents = { RENAMED_TOKEN: "actual-parent", COORD: null };
    const parentGrant = { ...structuredClone(fixture.receipt.bindings[0]!.grant),
      grantId: "parent-grant", sandboxId: "actual-parent", epoch: "parent-epoch",
      issuedAt: new Date(Date.now() - 10_000).toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString() };
    const parentBinding = { ...binding, envName: "ORIGINAL_TOKEN" };
    const parentReceipt: ProxySecretReceipt = { ...structuredClone(fixture.receipt), sandboxId: "actual-parent",
      bindings: [{ envName: parentBinding.envName, secretRef: parentBinding.secretRef, grant: parentGrant }] };
    fixture.declarations = [inherited, coord];
    fixture.receipt.bindings = [
      { envName: inherited.envName, secretRef: inherited.secretRef,
        grant: { ...structuredClone(fixture.receipt.bindings[0]!.grant), parentGrantId: parentGrant.grantId } },
      { envName: coord.envName, secretRef: coord.secretRef,
        grant: { ...structuredClone(fixture.receipt.bindings[0]!.grant), grantId: "root-coord", identity: { ...parentGrant.identity, secretId: "coord-source" } } },
    ];
    let currentParents: Record<string, string | null> = parents;
    const gets = vi.fn(async (id: string) => id === "actual-parent" ? {
      ...fixture.box, id, egress: { get: async () => ({ proxySecrets: [parentBinding], proxySecretReceipt: parentReceipt }) },
    } : id === "proxy-box" ? fixture.box : null);
    const client = { ...fixture.client, get: gets, capabilities: async () => ({ proxySecrets: capability, proxySecretDelegation: 1 as const }) };
    fixture.box.egress.get = async () => ({ proxySecrets: fixture.declarations, proxySecretReceipt: fixture.receipt, proxySecretParents: currentParents });
    const updates = vi.fn(async (update?: { proxySecrets: ProxySecretBinding[]; proxySecretParents?: Record<string, string | null> }) => {
      if (update === undefined) throw new Error("fixture requires explicit update");
      fixture.declarations = update.proxySecrets;
      if (update.proxySecretParents !== undefined) currentParents = update.proxySecretParents;
      if (update.proxySecrets.length === 0) fixture.receipt = { ...fixture.receipt, generation: fixture.receipt.generation + 1, status: "revoked", bindings: [] };
      return { proxySecrets: fixture.declarations, proxySecretReceipt: fixture.receipt, proxySecretParents: currentParents };
    });
    fixture.box.egress.update = updates;
    const input = { profile: { name: "mixed", harness: "opencode" as const }, proxySecrets: [inherited, coord], proxySecretParents: parents };
    return { fixture, client, gets, updates, input, parents, parentReceipt, setParents(value: typeof currentParents) { currentParents = value; } };
  }

  it("uses actual parent identity despite a renamed environment and independent coordination", async () => {
    const m = mapped();
    const provider = createTangleProvider({ client: m.client });
    const environment = await provider.create(m.input);
    expect(environment.proxySecretParents).toEqual(m.parents);
    expect(m.gets).toHaveBeenCalledWith("actual-parent", undefined);
    const recovered = await provider.get?.(environment.id);
    expect(recovered?.proxySecretParents).toEqual(m.parents);
    await provider.get?.(environment.id, { proxySecrets: m.input.proxySecrets });
    expect(m.updates).toHaveBeenCalledWith(expect.objectContaining({ proxySecretParents: m.parents }), undefined);
  });

  it.each(["missing", "null", "other", "scope", "expired"] as const)("refuses invalid current mapped authority (%s)", async (fault) => {
    const m = mapped();
    if (fault === "missing") m.setParents({});
    if (fault === "null") m.setParents({ RENAMED_TOKEN: null, COORD: null });
    if (fault === "other") m.setParents({ RENAMED_TOKEN: "different-parent", COORD: null });
    if (fault === "scope") m.parentReceipt.bindings[0]!.grant.scope.hosts = ["different.example.com"];
    if (fault === "expired") m.parentReceipt.bindings[0]!.grant.expiresAt = new Date(Date.now() - 500).toISOString();
    await expect(createTangleProvider({ client: m.client }).create(m.input)).rejects.toThrow();
    expect(m.fixture.turns).not.toHaveBeenCalled();
    if (fault === "expired") expect(m.fixture.creates).toHaveLength(0);
  });

  it("refuses changed pins and omitted maps for new tuples before PATCH", async () => {
    const m = mapped();
    const provider = createTangleProvider({ client: m.client });
    await provider.create(m.input);
    await expect(provider.get?.("proxy-box", { proxySecrets: m.input.proxySecrets, proxySecretParents: { RENAMED_TOKEN: null, COORD: null } })).rejects.toThrow(/acknowledged revocation/);
    await expect(provider.get?.("proxy-box", { proxySecrets: [{ ...binding, envName: "NEW_TUPLE" }] })).rejects.toThrow(/new tuple.*explicit total parent map/i);
    expect(m.updates).not.toHaveBeenCalled();
  });

  it("requires acknowledged empty revocation and exact PATCH map readback", async () => {
    const m = mapped();
    const provider = createTangleProvider({ client: m.client });
    await provider.create(m.input);
    const revoked = await provider.get?.("proxy-box", { proxySecrets: [], proxySecretParents: {} });
    expect(revoked?.proxySecretReceipt?.status).toBe("revoked");
    expect(revoked?.proxySecretParents).toEqual({});
  });

  it("blocks retained dispatch after a pin changes", async () => {
    const m = mapped();
    const environment = await createTangleProvider({ client: m.client }).create(m.input);
    m.setParents({ RENAMED_TOKEN: null, COORD: null });
    await expect((async () => { for await (const _event of environment.stream({ prompt: "fixture" })) {} })()).rejects.toThrow(/parent map readback/);
    expect(m.fixture.turns).not.toHaveBeenCalled();
  });
});


describe("newly observed mutation maps", () => {
  it("requires negotiation when only a PATCH response first exposes a map", async () => {
    const fixture = setup();
    fixture.box.egress.update = async () => ({ proxySecretReceipt: fixture.receipt, proxySecretParents: { REPORTS_TOKEN: null } });
    await expect(createTangleProvider({ client: fixture.client }).get?.("proxy-box", { proxySecrets: [binding] }))
      .rejects.toThrow(/delegation.*capabilit/i);
  });

  it("requires a newly observed PATCH map to survive current GET readback", async () => {
    const fixture = setup();
    const client = { ...fixture.client, capabilities: async () => ({ proxySecrets: capability, proxySecretDelegation: 1 as const }) };
    fixture.box.egress.update = async () => ({ proxySecretReceipt: fixture.receipt, proxySecretParents: { REPORTS_TOKEN: null } });
    await expect(createTangleProvider({ client }).get?.("proxy-box", { proxySecrets: [binding] }))
      .rejects.toThrow(/parent map readback/);
  });
});


describe("native renewal parent controls", () => {
  it.each(["marker-missing", "readback-missing", "mapped"] as const)("checks mutation maps before dispatch (%s)", async (mode) => {
    const fixture = setup();
    const parents = { REPORTS_TOKEN: null };
    fixture.box.capabilities = async () => ({ proxySecrets: capability, cliAuthReferences: true, codexCredentialContinuations: true });
    const client = { ...fixture.client, capabilities: async () => ({ proxySecrets: capability,
      ...(mode === "marker-missing" ? {} : { proxySecretDelegation: 1 as const }) }) };
    if (mode === "mapped") fixture.box.egress.get = async () => ({ proxySecrets: fixture.declarations, proxySecretReceipt: fixture.receipt, proxySecretParents: parents });
    fixture.grants.mockImplementation(async () => ({ proxySecretReceipt: fixture.receipt, proxySecretParents: parents }));
    const native = { ...profile, harness: "codex" as const, model: { metadata: { credentialSource: "subscription" } } };
    const selected = { cliAuth: { account: "seat", secretEnv: "NATIVE_BUNDLE", format: "bundle" as const }, proxySecrets: [binding] };
    const environment = await createTangleProvider({ client, modelCredentials: async () => selected })
      .create({ profile: native, ...(mode === "mapped" ? { proxySecretParents: parents } : {}) });
    const turn = async () => { for await (const _event of environment.stream({ prompt: "fixture", profile: native, turnId: "parent-renewal" })) {} };
    if (mode === "mapped") {
      await turn();
      expect(fixture.grants).toHaveBeenCalledWith(expect.objectContaining({ proxySecretParents: parents }), undefined);
      expect(fixture.turns).toHaveBeenCalledTimes(1);
    } else {
      await expect(turn()).rejects.toThrow(mode === "marker-missing" ? /delegation.*capabilit/i : /parent map readback/i);
      expect(fixture.turns).not.toHaveBeenCalled();
    }
  });
});

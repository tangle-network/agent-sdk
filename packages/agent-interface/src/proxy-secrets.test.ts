import { ProxySecretParentsSchema, isProxySecretParentsTotal } from "./environment-provider.js";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { type CreateAgentEnvironmentInput, type ProxySecretBinding, AgentEnvironmentGetOptionsSchema, ProxySecretBindingSchema, ProxySecretCapabilitiesSchema, ProxySecretGrantSchema, ProxySecretReceiptSchema, ProxySecretsSchema, isProxySecretGrantAttenuation, isProxySecretBindingAttenuation, mergeProxySecretBindings } from "./environment-provider.js";
import { agentProfileSchema } from "./profile-schema.js";
import { mergeAgentProfiles } from "./agent-profile.js";
import { snapshotAgentProfile } from "./agent-profile-snapshot.js";
import { canonicalAgentProfileDigest } from "./agent-execution-preparation.js";
import { profileMaterializationRequests } from "./agent-profile-materialization.js";
import { agentCandidateProfilePlanMaterialSchema } from "./agent-candidate-execution-plan-schema.js";
import { canonicalCandidateDigest } from "./agent-candidate-schema-common.js";
import { agentCandidateProfileSchema } from "./agent-candidate-profile-schema.js";
import { applyAgentProfileDiff, changedAgentProfileAxes } from "./profile-diff.js";

const binding = { envName: "REPORTS_TOKEN", secretRef: { kind: "secret-ref", key: "reporting-api" }, hosts: ["reports.example.com"], presentation: { type: "bearer" }, methods: ["POST"], paths: ["/v1/events/*"], ttlSeconds: 300 };
const grant = { protocolVersion: 1, grantId: "grant-1", sandboxId: "box-1", epoch: "epoch-1", identity: { tenantId: "tenant-1", issuerId: "issuer-1", secretId: "secret-1", revision: "revision-1" }, scope: { hosts: binding.hosts, methods: binding.methods, paths: binding.paths }, presentation: binding.presentation, placeholderFormat: "opaque", issuedAt: "2026-10-15T00:00:00.000Z", expiresAt: "2026-10-15T00:05:00.000Z" };
const fixture = JSON.parse(readFileSync(new URL("../fixtures/proxy-secret-wire-v1.json", import.meta.url), "utf8")) as { declarations: { name: string; value: unknown; valid: boolean }[] };

describe("portable proxy-secret public contract", () => {
  it("accepts immutable declarations from the advertised SDK syntax", () => {
    const authored = {
      envName: "REPORTS_TOKEN",
      secretRef: { kind: "secret-ref", key: "reporting-api" },
      hosts: ["reports.example.com"],
      presentation: { type: "bearer" },
      methods: ["POST"],
      paths: ["/v1/events"],
    } as const satisfies ProxySecretBinding;
    const input = { profile: {}, proxySecrets: [authored] } as const satisfies CreateAgentEnvironmentInput;
    expect(ProxySecretsSchema.parse(input.proxySecrets)).toEqual([authored]);
  });
  it.each(fixture.declarations)("validates shared declaration $name", ({ value, valid }) => {
    expect(ProxySecretBindingSchema.safeParse(value).success).toBe(valid);
  });
  it("validates explicit retained-custody attachment controls and preserves revocation", () => {
    expect(AgentEnvironmentGetOptionsSchema.parse({ proxySecrets: [], expectedProxySecretGeneration: 2, requireInPlace: true })).toEqual({ proxySecrets: [], expectedProxySecretGeneration: 2, requireInPlace: true });
    expect(AgentEnvironmentGetOptionsSchema.safeParse({ expectedProxySecretGeneration: 2 }).success).toBe(false);
    expect(AgentEnvironmentGetOptionsSchema.safeParse({ proxySecrets: [binding], expectedProxySecretGeneration: -1 }).success).toBe(false);
  });
  it("merges independent declarations with exact conflict refusal", () => {
    const parsed = ProxySecretBindingSchema.parse(binding);
    expect(mergeProxySecretBindings(undefined, [parsed], [{ ...parsed }])).toEqual([parsed]);
    expect(mergeProxySecretBindings([])).toEqual([]);
    expect(() => mergeProxySecretBindings([parsed], [{ ...parsed, hosts: ["other.example.com"] }])).toThrow(/disagree/);
  });
  it("rejects plaintext, ambiguity and duplicate binding names", () => {
    expect(ProxySecretsSchema.safeParse([binding, binding]).success).toBe(false);
    expect(ProxySecretBindingSchema.safeParse({ ...binding, value: "forbidden" }).success).toBe(false);
    expect(ProxySecretBindingSchema.safeParse({ ...binding, presentation: { type: "header", name: "Authorization" } }).success).toBe(false);
  });
  it("roundtrips profiles, snapshots, candidate evidence and scope-sensitive identity", () => {
    const profile = agentProfileSchema.parse({ proxySecrets: [binding] });
    expect(profile.proxySecrets).toEqual([binding]);
    expect(agentCandidateProfileSchema.parse(profile)).toEqual(profile);
    const snapshot = snapshotAgentProfile(profile);
    expect(Object.isFrozen(snapshot.proxySecrets?.[0]?.hosts)).toBe(true);
    for (const edit of [{ ttlSeconds: 60 }, { hosts: ["other.example.com"] }, { paths: ["/v2/events"] }, { secretRef: { kind: "secret-ref", key: "other-api" } }]) {
      expect(canonicalAgentProfileDigest(profile)).not.toBe(canonicalAgentProfileDigest(agentProfileSchema.parse({ proxySecrets: [{ ...binding, ...edit }] })));
    }
    expect(profileMaterializationRequests(profile)).toContainEqual({ axis: "proxySecrets", path: "/proxySecrets/0/ttlSeconds" });
    expect(mergeAgentProfiles(profile, { proxySecrets: [] })?.proxySecrets).toEqual([]);
    const diff = { kind: "agent-profile-diff" as const, remove: { proxySecrets: true as const } };
    expect(changedAgentProfileAxes(diff)).toEqual(["proxySecrets"]);
    expect(applyAgentProfileDiff(profile, diff).proxySecrets).toBeUndefined();
  });
  it("requires metadata-only acknowledged receipts and protocol agreement", () => {
    expect(ProxySecretGrantSchema.parse(grant)).toEqual(grant);
    const receipt = { protocolVersion: 1, sandboxId: "box-1", generation: 1, status: "installed", bindings: [{ envName: binding.envName, secretRef: binding.secretRef, grant }], proxyAcknowledged: true, materializationAcknowledged: true };
    expect(ProxySecretReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(ProxySecretReceiptSchema.parse({ ...receipt, status: "proxy-installed", materializationAcknowledged: false }).status).toBe("proxy-installed");
    expect(ProxySecretReceiptSchema.safeParse({ ...receipt, placeholder: "forbidden" }).success).toBe(false);
    expect(ProxySecretReceiptSchema.safeParse({ ...receipt, proxyAcknowledged: false }).success).toBe(false);
    expect(ProxySecretReceiptSchema.safeParse({ ...receipt, sandboxId: "foreign-box" }).success).toBe(false);
    expect(ProxySecretReceiptSchema.safeParse({
      ...receipt, bindings: [...receipt.bindings, {
        envName: "SECOND_TOKEN", secretRef: binding.secretRef,
        grant: { ...grant, grantId: "grant-2", epoch: "stale-epoch" },
      }],
    }).success).toBe(false);
    expect(ProxySecretCapabilitiesSchema.safeParse({ protocolVersion: 2 }).success).toBe(false);
  });
  it("keeps reference slot placement in canonical candidate identity", () => {
    const ref = { kind: "secret-ref" as const, key: "reporting-api", format: "bearer" as const };
    expect(agentCandidateProfileSchema.parse({ mcp: { reports: { command: "reports-mcp", env: { REPORTS_TOKEN: ref } } } }).mcp?.reports).toBeDefined();
    const plan = { proxySecrets: [binding], sourceProfileDigest: "sha256:" + "a".repeat(64), harness: "codex", files: [{ relPath: "auth.json", mode: 384, contentSha256: "sha256:" + "b".repeat(64), secretSlots: [{ path: ["token"], ref }] }], env: {}, flags: [], unsupported: [] };
    expect(agentCandidateProfilePlanMaterialSchema.safeParse({ ...plan, systemPrompt: ref }).success).toBe(false);
    const parsed = agentCandidateProfilePlanMaterialSchema.parse(plan);
    expect(parsed.proxySecrets).toEqual([binding]);
    const changedScope = agentCandidateProfilePlanMaterialSchema.parse({ ...plan, proxySecrets: [{ ...binding, hosts: ["other.example.com"] }] });
    expect(canonicalCandidateDigest(parsed)).not.toBe(canonicalCandidateDigest(changedScope));
    const changed = agentCandidateProfilePlanMaterialSchema.parse({ ...plan, files: [{ ...plan.files[0], secretSlots: [{ path: ["other"], ref }] }] });
    expect(canonicalCandidateDigest(parsed)).not.toBe(canonicalCandidateDigest(changed));
    expect(agentCandidateProfilePlanMaterialSchema.safeParse({ ...plan, files: [{ ...plan.files[0], secretSlots: [{ path: ["token"], ref }, { path: ["token", "child"], ref }] }] }).success).toBe(false);
  });
  it("compares declarations conservatively before trusted identity resolution", () => {
    const parent = ProxySecretBindingSchema.parse(binding);
    expect(isProxySecretBindingAttenuation(parent, { ...parent, paths: ["/v1/events/one"], ttlSeconds: 60 })).toBe(true);
    expect(isProxySecretBindingAttenuation(parent, { ...parent, methods: undefined })).toBe(false);
    expect(isProxySecretBindingAttenuation(parent, { ...parent, secretRef: { kind: "secret-ref", key: "foreign" } })).toBe(false);
    expect(isProxySecretBindingAttenuation(parent, { ...parent, paths: ["/v1/eventspill"] })).toBe(false);
  });
  it("compares resolved identity, exact presentation, scope and absolute expiry for attenuation", () => {
    const parent = ProxySecretGrantSchema.parse(grant);
    const child = ProxySecretGrantSchema.parse({ ...grant, grantId: "grant-2", sandboxId: "box-2", epoch: "epoch-2", parentGrantId: parent.grantId, scope: { ...grant.scope, paths: ["/v1/events/one"] }, expiresAt: "2026-10-15T00:04:00.000Z" });
    expect(isProxySecretGrantAttenuation(parent, child)).toBe(true);
    expect(isProxySecretGrantAttenuation(parent, { ...child, scope: { ...child.scope, paths: ["/v1/eventspill"] } })).toBe(false);
    expect(isProxySecretGrantAttenuation(parent, { ...child, identity: { ...child.identity, revision: "foreign" } })).toBe(false);
    expect(isProxySecretGrantAttenuation(parent, { ...child, expiresAt: "2026-10-15T00:06:00.000Z" })).toBe(false);
  });
});


describe("host-only canonical parent map", () => {
  it("admits mixed string/null pins with exact final selection keys", () => {
    const parsed = ProxySecretBindingSchema.parse(binding);
    const coord = { ...parsed, envName: "COORD" };
    const parents = { REPORTS_TOKEN: "actual-parent", COORD: null };
    expect(ProxySecretParentsSchema.parse(parents)).toEqual(parents);
    expect(isProxySecretParentsTotal([parsed, coord], parents)).toBe(true);
    for (const invalid of [{}, { REPORTS_TOKEN: null }, { ...parents, EXTRA: null },
      { ...parents, COORD: undefined }, { ...parents, COORD: { sandboxId: "parent" } },
      { ...parents, REPORTS_TOKEN: "" }, []]) {
      expect(isProxySecretParentsTotal([parsed, coord], invalid)).toBe(false);
    }
    expect(isProxySecretParentsTotal([], {})).toBe(true);
    expect(AgentEnvironmentGetOptionsSchema.safeParse({ proxySecretParents: {} }).success).toBe(false);
    expect(AgentEnvironmentGetOptionsSchema.parse({ proxySecrets: [], proxySecretParents: {} })).toEqual({ proxySecrets: [], proxySecretParents: {} });
    expect(AgentEnvironmentGetOptionsSchema.safeParse({ proxySecrets: [binding], proxySecretParents: {} }).success).toBe(false);
    expect(agentProfileSchema.safeParse({ proxySecrets: [binding], proxySecretParents: parents }).success).toBe(false);
  });
});

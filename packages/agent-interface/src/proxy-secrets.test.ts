import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ProxySecretBindingSchema, ProxySecretCapabilitiesSchema, ProxySecretGrantSchema, ProxySecretReceiptSchema, ProxySecretsSchema, isProxySecretGrantAttenuation } from "./environment-provider.js";
import { agentProfileSchema } from "./profile-schema.js";
import { mergeAgentProfiles } from "./agent-profile.js";
import { snapshotAgentProfile } from "./agent-profile-snapshot.js";
import { canonicalAgentProfileDigest } from "./agent-execution-preparation.js";
import { profileMaterializationRequests } from "./agent-profile-materialization.js";
import { agentCandidateProfileSchema } from "./agent-candidate-profile-schema.js";
import { applyAgentProfileDiff, changedAgentProfileAxes } from "./profile-diff.js";

const binding = { envName: "REPORTS_TOKEN", secretRef: { kind: "secret-ref", key: "reporting-api" }, hosts: ["reports.example.com"], presentation: { type: "bearer" }, methods: ["POST"], paths: ["/v1/events/*"], ttlSeconds: 300 };
const grant = { protocolVersion: 1, grantId: "grant-1", sandboxId: "box-1", epoch: "epoch-1", identity: { tenantId: "tenant-1", issuerId: "issuer-1", secretId: "secret-1", revision: "revision-1" }, scope: { hosts: binding.hosts, methods: binding.methods, paths: binding.paths }, presentation: binding.presentation, placeholderFormat: "opaque", issuedAt: "2026-10-15T00:00:00.000Z", expiresAt: "2026-10-15T00:05:00.000Z" };
const fixture = JSON.parse(readFileSync(new URL("../fixtures/proxy-secret-wire-v1.json", import.meta.url), "utf8")) as { declarations: { name: string; value: unknown; valid: boolean }[] };

describe("portable proxy-secret public contract", () => {
  it.each(fixture.declarations)("validates shared declaration $name", ({ value, valid }) => {
    expect(ProxySecretBindingSchema.safeParse(value).success).toBe(valid);
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
    expect(canonicalAgentProfileDigest(profile)).not.toBe(canonicalAgentProfileDigest(agentProfileSchema.parse({ proxySecrets: [{ ...binding, ttlSeconds: 60 }] })));
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
    expect(ProxySecretReceiptSchema.safeParse({ ...receipt, placeholder: "forbidden" }).success).toBe(false);
    expect(ProxySecretReceiptSchema.safeParse({ ...receipt, proxyAcknowledged: false }).success).toBe(false);
    expect(ProxySecretReceiptSchema.safeParse({ ...receipt, sandboxId: "foreign-box" }).success).toBe(false);
    expect(ProxySecretCapabilitiesSchema.safeParse({ protocolVersion: 2 }).success).toBe(false);
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

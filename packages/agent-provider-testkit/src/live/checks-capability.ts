import { harnessSystemPromptIntents, type AgentProfile } from "@tangle-network/agent-interface";
import {
  AgentEnvironmentCapabilitiesSchema,
  isEnvironmentProviderError,
  type AgentEnvironment,
  type AgentEnvironmentCapabilities,
} from "@tangle-network/agent-interface/environment-provider";
import { checkCapabilityExposure, environmentCapabilityDocument } from "../conformance-helpers.js";
import { runWorkspaceSnapshotConformance } from "../workspace-snapshot-conformance.js";
import { errorSummary, namesField, type LiveContext } from "./context.js";

/** Profile axes SPEC.md 3.2 requires a provider to refuse unless it implements them. */
function refusedAxisProfiles(ctx: LiveContext): { path: string; profile: AgentProfile }[] {
  const { harness, model } = ctx.options;
  const base: AgentProfile = { name: `${ctx.runTag}-axis`, harness, model: { default: model } };
  const cases: { path: string; profile: AgentProfile; unless: boolean }[] = [
    { path: "confidential", profile: { ...base, confidential: { tee: "any" } }, unless: ctx.capabilities.confidential },
    { path: "seats", profile: { ...base, seats: [{ harness, provider: "tangle-router", model, selector: { kind: "all-eligible" } }] }, unless: false },
    { path: "connections", profile: { ...base, connections: [{ connectionId: "conformance", capabilities: ["x"] }] }, unless: false },
    { path: "maxVisibleOutputTokens", profile: { ...base, model: { default: model, maxVisibleOutputTokens: 100 } }, unless: false },
    { path: "knowledge", profile: { ...base, resources: { knowledge: [{ sourceId: "conformance", generation: "g1" }] } }, unless: false },
    { path: "proxySecrets", profile: { ...base, proxySecrets: [{ name: "CONFORMANCE", destination: { host: "example.com" } } as never] }, unless: ctx.capabilities.create?.proxySecrets !== undefined },
  ];
  return cases.filter((entry) => !entry.unless).map(({ path, profile }) => ({ path, profile }));
}

/** CAP-1, CAP-4 (document half), CAP-5, MAT-7 (refusals), MOD-4, ERR-3 for validateProfile. */
export async function checkProviderDocument(ctx: LiveContext): Promise<void> {
  const { rec, provider, options } = ctx;
  const parsed = AgentEnvironmentCapabilitiesSchema.safeParse(ctx.capabilities);
  rec.observe("CAP-1", parsed.success && ctx.capabilities.create !== undefined, parsed.success ? (ctx.capabilities.create === undefined ? "document has no create block stating an honored field" : "schema parses; create block present") : `schema: ${parsed.error.issues[0]?.message}`);
  const intents = harnessSystemPromptIntents(options.harness);
  const claimed = ctx.capabilities.profile.systemPrompt;
  rec.observe("CAP-4", (!claimed.replace || intents.replace) && (!claimed.append || intents.append), `systemPrompt replace=${claimed.replace}/append=${claimed.append} against harness intents replace=${intents.replace}/append=${intents.append}`);
  if (typeof provider.validateProfile !== "function") {
    rec.fail("CAP-5", "provider has no validateProfile");
    return;
  }
  for (const { path, profile } of refusedAxisProfiles(ctx)) {
    const result = await provider.validateProfile(profile);
    const issue = result.issues.find((entry) => entry.level === "error" && entry.code !== undefined && entry.path !== undefined);
    const ok = !result.ok && issue !== undefined;
    rec.observe("CAP-5", ok, ok ? `${path} refused with ${issue.code} at ${issue.path}` : `${path} was not refused by validateProfile with a code and path`);
    rec.observe("MAT-7", ok, `${path}: ${ok ? "refused at validateProfile" : "neither materialized nor refused"}`);
  }
  const noHarness = await provider.validateProfile({ name: `${ctx.runTag}-noharness` });
  rec.observe("MAT-1", !noHarness.ok, noHarness.ok ? "a profile naming no harness validates" : "a profile naming no harness is refused");
  const subscription = await provider.validateProfile({ ...ctx.profile, model: { ...ctx.profile.model, metadata: { credentialSource: "subscription" } } });
  if (!subscription.ok) rec.pass("MOD-4", "a subscription profile is refused at validateProfile, not run on a managed key");
  else rec.unproven("MOD-4", "validateProfile accepts a subscription profile; delivery of native credentials is not probed");
  const valid = await provider.validateProfile(ctx.profile);
  rec.observe("CAP-5", valid.ok, valid.ok ? "the probe profile validates" : `the probe profile was refused: ${valid.issues.map((i) => i.message).join("; ").slice(0, 200)}`);
}

/** CAP-2: every optional method is present iff its flag is true, on the provider document and each environment. */
export function checkExposure(ctx: LiveContext, environment: AgentEnvironment): AgentEnvironmentCapabilities {
  const document = environmentCapabilityDocument(environment, ctx.capabilities);
  const checked: string[] = [];
  try {
    checkCapabilityExposure(environment, document, checked);
    ctx.rec.pass("CAP-2", "optional methods match the environment's capability flags");
  } catch (error) {
    ctx.rec.fail("CAP-2", error instanceof Error ? error.message : String(error));
  }
  return document;
}

/** A refusal is typed (ERR-1) and names its field (ERR-3). */
export function recordRefusal(ctx: LiveContext, field: string, error: unknown): void {
  ctx.refusals.push(error);
  ctx.rec.observe("ERR-3", namesField(error, field), `${field}: ${errorSummary(error)}`);
}

/** CRT-2 and the create-side refusals of SPEC.md 3.1, each with zero provisioned effect checked later by the leak sweep. */
export async function checkCreateRefusals(ctx: LiveContext): Promise<void> {
  const { rec, capabilities } = ctx;
  type Case = { field: string; requirement: "CRT-2" | "CRT-4" | "SEC-2" | "WSP-4" | "WSP-5" | "MAT-1" | "MAT-4"; overrides: Parameters<LiveContext["expectRefusal"]>[0]; unless: boolean };
  const cases: Case[] = [
    { field: "runtimeAttachments", requirement: "CRT-2", overrides: { runtimeAttachments: { mcp: { servers: [] } } as never }, unless: capabilities.create?.runtimeAttachments !== undefined },
    { field: "idempotencyKey", requirement: "CRT-4", overrides: { idempotencyKey: `${ctx.runTag}-key` }, unless: capabilities.create?.durableIdempotency === true },
    { field: "billingOwner", requirement: "CRT-2", overrides: { billingOwner: "conformance-owner" }, unless: capabilities.create?.billingOwner === true },
    { field: "egress", requirement: "CRT-2", overrides: { egress: { mode: "blocked" } }, unless: capabilities.create?.egress?.includes("blocked") === true },
    { field: "checkpoint", requirement: "WSP-5", overrides: { workspace: { checkpoint: { id: "cp-conformance", provider: "other-provider" } as never } }, unless: capabilities.create?.workspaceCheckpoint === true },
    { field: "providerOptions", requirement: "CRT-2", overrides: { providerOptions: { conformanceUnknownOption: true } }, unless: false },
    { field: "cwd", requirement: "CRT-2", overrides: { workspace: { cwd: { base: "host", path: "/tmp" } } }, unless: capabilities.workspace.cwdBases?.host === true },
    { field: "image", requirement: "WSP-4", overrides: { workspace: { environment: "conformance-env", image: "conformance-image" } }, unless: false },
    { field: "permissions", requirement: "MAT-4", overrides: { profile: { ...ctx.profile, permissions: { mcp__conformance__tool: "allow" } as never } }, unless: false },
    { field: "harness", requirement: "MAT-1", overrides: { profile: { name: `${ctx.runTag}-noharness` } }, unless: false },
    { field: "backend", requirement: "MAT-1", overrides: { backend: ctx.options.harness === "codex" ? "claude-code" : "codex" }, unless: false },
  ];
  for (const entry of cases.filter((candidate) => !candidate.unless)) {
    const outcome = await ctx.expectRefusal(entry.overrides, entry.field);
    rec.observe(entry.requirement, outcome.refused, outcome.refused ? `${entry.field} refused: ${errorSummary(outcome.error)}` : `${entry.field} was accepted and an environment returned`);
    if (outcome.refused) recordRefusal(ctx, entry.field, outcome.error);
    if (entry.requirement !== "CRT-2") rec.observe("CRT-2", outcome.refused, `${entry.field} (see ${entry.requirement})`);
  }
  for (const { path, profile } of refusedAxisProfiles(ctx)) {
    const outcome = await ctx.expectRefusal({ profile }, path);
    rec.observe("MAT-7", outcome.refused, `${path}: ${outcome.refused ? "create refused it" : "create accepted it"}`);
    if (outcome.refused) recordRefusal(ctx, path, outcome.error);
  }
  const secrets = await ctx.expectRefusal({ secrets: { CONFORMANCE_SECRET: ctx.nonces.canary } }, "secrets");
  if (secrets.refused) {
    rec.pass("SEC-2", `a name-to-value secrets map is refused: ${errorSummary(secrets.error)}`);
    recordRefusal(ctx, "secrets", secrets.error);
  } else rec.unproven("SEC-2", "a secrets map was accepted; vendor-native delivery is not probed");
  const resources = await ctx.expectRefusal({ resources: { cpu: 1, memoryMb: 512 } }, "resources");
  if (resources.refused) {
    rec.pass("WSP-6", `resources are refused rather than dropped: ${errorSummary(resources.error)}`);
    recordRefusal(ctx, "resources", resources.error);
  } else rec.unproven("WSP-6", "resources were accepted; that the vendor honored them is not probed");
  const snapshot = await runWorkspaceSnapshotConformance({ name: ctx.options.name, createProvider: ctx.options.createProvider, createInput: { profile: ctx.profile, ...(ctx.options.createInput ?? {}) } })
    .then(() => undefined, (error: unknown) => error);
  if (capabilities.create?.workspaceSnapshot !== true) rec.observe("CRT-2", snapshot === undefined, snapshot === undefined ? "workspace.snapshot refused after reconstruction" : `workspace.snapshot: ${errorSummary(snapshot)}`);
}

export function isTyped(ctx: LiveContext): void {
  const typed = ctx.refusals.filter((error) => isEnvironmentProviderError(error));
  ctx.rec.observe("ERR-1", ctx.refusals.length > 0 && typed.length === ctx.refusals.length, `${typed.length} of ${ctx.refusals.length} refusals carry an EnvironmentProviderErrorCode (auth_failed and capacity codes are not exercised)`);
  const bounded = ctx.refusals.every((error) => error instanceof Error && error.message.length <= 2_000);
  ctx.rec.observe("ERR-2", bounded, bounded ? "refusal messages are bounded to 2,000 characters" : "a refusal message exceeds 2,000 characters");
}

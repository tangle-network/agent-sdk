import {
  harnessSystemPromptIntents,
  type AgentProfile,
  type AgentProfileValidationIssue,
  type AgentProfileValidationResult,
  type HarnessType,
} from "@tangle-network/agent-interface";
import { EnvironmentProviderError } from "@tangle-network/agent-interface/environment-provider";
import type { CreateAgentEnvironmentInput } from "@tangle-network/agent-interface/environment-provider";
import { materializeProfile } from "@tangle-network/agent-profile-materialize";
import { harnessModelSupportFor } from "@tangle-network/cli-agent-registry";
import { BOX_HARNESSES, boxHarness } from "./box.js";
import type { BridgeVendorSupport } from "./vendor.js";

/** A profile axis no workspace control enforces here, with the reason it is refused. */
const REFUSED_PROFILE_AXES: ReadonlyArray<{ path: string; present: (profile: AgentProfile) => boolean; reason: string }> = [
  { path: "profile.confidential", present: (p) => p.confidential !== undefined, reason: "confidential execution needs placement and attestation this provider does not offer" },
  { path: "profile.seats", present: (p) => p.seats !== undefined, reason: "an ordered subscription chain is not implemented; this provider runs one Router-routed model" },
  { path: "profile.connections", present: (p) => (p.connections?.length ?? 0) > 0, reason: "connections must be resolved to MCP servers before create" },
  { path: "profile.proxySecrets", present: (p) => p.proxySecrets !== undefined, reason: "proxy-held credentials are not supported" },
  { path: "profile.resources.knowledge", present: (p) => Array.isArray(Reflect.get(p.resources ?? {}, "knowledge")) && (Reflect.get(p.resources ?? {}, "knowledge") as unknown[]).length > 0, reason: "knowledge must be resolved by the runtime before materialization" },
  { path: "profile.model.maxVisibleOutputTokens", present: (p) => p.model?.maxVisibleOutputTokens !== undefined, reason: "no workspace control enforces an output token cap" },
  { path: "profile.model.maxReasoningTokens", present: (p) => p.model?.maxReasoningTokens !== undefined, reason: "no workspace control enforces a reasoning token cap" },
  { path: "profile.model.maxTotalOutputTokens", present: (p) => p.model?.maxTotalOutputTokens !== undefined, reason: "no workspace control enforces a total output token cap" },
  { path: "profile.extensions", present: (p) => Object.values(p.extensions ?? {}).some((value) => value !== undefined), reason: "no backend extension namespace is implemented" },
];

function metadataCredentialSource(profile: AgentProfile): unknown {
  const metadata = profile.model?.metadata;
  return metadata !== null && typeof metadata === "object" ? (metadata as Record<string, unknown>).credentialSource : undefined;
}

/** The harness a request selects, or the refusal that names why none can be. */
export function resolveBoxHarness(
  profile: AgentProfile,
  backend: string | undefined,
  declared: readonly HarnessType[],
): HarnessType {
  const selected = profile.harness ?? backend;
  if (selected === undefined) {
    throw new EnvironmentProviderError("refused", "a profile or backend must name a harness; a prompt is never run as a shell command", { path: "profile.harness" });
  }
  if (profile.harness !== undefined && backend !== undefined && profile.harness !== backend) {
    throw new EnvironmentProviderError("refused", `backend ${backend} conflicts with profile.harness ${profile.harness}`, { path: "backend" });
  }
  if (!declared.includes(selected as HarnessType) || boxHarness(selected) === undefined) {
    throw new EnvironmentProviderError("refused", `harness ${selected} is not in this provider's declared set (${declared.join(", ")})`, { path: backend === undefined ? "profile.harness" : "backend" });
  }
  return selected as HarnessType;
}

/**
 * Validate a profile against what the box can run, without any sandbox call.
 *
 * It plans with the same materializer the Bridge in the box uses, so a
 * dimension the planner cannot lower is refused here with its own reason.
 */
export function validateBoxProfile(
  profile: AgentProfile,
  backend: string | undefined,
  declared: readonly HarnessType[],
): AgentProfileValidationResult {
  const issues: AgentProfileValidationIssue[] = [];
  const error = (code: string, path: string, message: string): void => {
    issues.push({ level: "error", code, path, message });
  };
  let harness: HarnessType | undefined;
  try {
    harness = resolveBoxHarness(profile, backend, declared);
  } catch (caught) {
    const refusal = caught as EnvironmentProviderError;
    error("harness_refused", refusal.path ?? "profile.harness", refusal.message);
  }
  for (const axis of REFUSED_PROFILE_AXES) {
    if (axis.present(profile)) error("axis_refused", axis.path, axis.reason);
  }
  if (metadataCredentialSource(profile) === "subscription") {
    error("subscription_refused", "profile.model.metadata.credentialSource", "subscription credentials are not delivered into a cloud box; the model routes through the Router, and a subscription profile is never run on a managed key");
  }
  if (harness !== undefined) {
    const intents = harnessSystemPromptIntents(harness);
    if (profile.prompt?.systemPrompt !== undefined && !intents.replace) error("system_prompt_refused", "profile.prompt.systemPrompt", `${harness} cannot replace its system prompt`);
    if (profile.prompt?.appendSystemPrompt !== undefined && !intents.append) error("system_prompt_refused", "profile.prompt.appendSystemPrompt", `${harness} cannot append to its system prompt`);
    const model = profile.model?.default;
    if (model !== undefined) {
      const support = harnessModelSupportFor(harness, { provider: profile.model?.provider, model });
      if (!support.supported) error("model_refused", "profile.model.default", support.message);
    }
    try {
      const plan = materializeProfile(profile, harness as Parameters<typeof materializeProfile>[1]);
      for (const entry of plan.unsupported) error("unsupported", `profile.${entry.dimension}`, entry.reason);
    } catch (caught) {
      error("materialization_refused", "profile", caught instanceof Error ? caught.message : String(caught));
    }
  }
  return { ok: !issues.some((issue) => issue.level === "error"), issues };
}

/** Throw the first refusal of a validation result as a typed error that names its path. */
export function assertProfileValid(result: AgentProfileValidationResult): void {
  const first = result.issues.find((issue) => issue.level === "error");
  if (first !== undefined) {
    throw new EnvironmentProviderError("refused", first.message, { ...(first.path === undefined ? {} : { path: first.path }) });
  }
}

/**
 * Refuse every create-input field this provider cannot honor, before any
 * vendor call. A field is never accepted and dropped.
 */
export function refuseUnsupportedCreateInput(
  input: CreateAgentEnvironmentInput,
  support: BridgeVendorSupport,
): void {
  const refuse = (path: string, message: string): never => {
    throw new EnvironmentProviderError("refused", message, { path });
  };
  if (typeof input.profile === "string") refuse("profile", `named profile ${input.profile} is unsupported; pass an inline AgentProfile`);
  if (input.requestedId !== undefined) refuse("requestedId", "the vendor issues sandbox ids");
  if (input.runtimeAttachments !== undefined) refuse("runtimeAttachments", "runtime MCP attachments are not supported");
  if (input.idempotencyKey !== undefined) refuse("idempotencyKey", "durable keyed create is not implemented");
  if (input.billingOwner !== undefined) refuse("billingOwner", "billing owners are not supported");
  if (input.secrets !== undefined) refuse("secrets", "secrets are not supported; pass env");
  if (input.proxySecrets !== undefined) refuse("proxySecrets", "proxy secrets are not supported");
  if (input.proxySecretParents !== undefined) refuse("proxySecretParents", "proxy secret parents are not supported");
  if (input.providerOptions !== undefined && Object.keys(input.providerOptions).length > 0) refuse("providerOptions", "no provider option is implemented");
  const workspace = input.workspace;
  if (workspace !== undefined) {
    if (workspace.snapshot !== undefined) refuse("workspace.snapshot", "workspace snapshots are not supported");
    if (workspace.checkpoint !== undefined) refuse("workspace.checkpoint", "workspace checkpoints are not supported");
    if (workspace.cwd?.base === "host") refuse("workspace.cwd", "a host cwd is refused; use base \"repository\"");
    if (workspace.providerOptions !== undefined && Object.keys(workspace.providerOptions).length > 0) refuse("workspace.providerOptions", "no workspace provider option is implemented");
    if (workspace.environment !== undefined && workspace.image !== undefined) refuse("workspace.image", "workspace cannot specify both environment and image");
    if (workspace.environment !== undefined && !support.environment) refuse("workspace.environment", "this vendor selects no template or snapshot");
    if (workspace.image !== undefined && !support.image) refuse("workspace.image", "this vendor selects no image");
  }
  if (input.resources !== undefined) {
    if (!support.resources) refuse("resources", "this vendor sets no resources at create");
    if (input.resources.providerOptions !== undefined) refuse("resources.providerOptions", "no resource provider option is implemented");
  }
  if (input.egress !== undefined && !support.egress.includes(input.egress.mode)) {
    refuse("egress", `egress mode ${input.egress.mode} is not enforced by this vendor`);
  }
}

/** The harnesses this module can declare. */
export function declarableHarnesses(): HarnessType[] {
  return Object.keys(BOX_HARNESSES) as HarnessType[];
}

/** Whether the shared planner lowers this profile dimension for the harness. */
export function plannerLowers(harness: HarnessType, dimension: "hooks"): boolean {
  const probe: AgentProfile = { hooks: { PostToolUse: [{ command: "true" }] } };
  try {
    const plan = materializeProfile(probe, harness as Parameters<typeof materializeProfile>[1]);
    return !plan.unsupported.some((entry) => entry.dimension === dimension);
  } catch {
    return false;
  }
}

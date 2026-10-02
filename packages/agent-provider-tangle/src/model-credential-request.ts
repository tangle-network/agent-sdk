import { agentProfileSchema } from "@tangle-network/agent-interface";
import type { CreateAgentEnvironmentInput } from "@tangle-network/agent-interface/environment-provider";
import { profileCredentialSource } from "./model-credential-source.js";
import { assertBoundedJson } from "./tangle-contract-safety.js";

export interface ModelCredentialResolverRequest {
  input: Readonly<CreateAgentEnvironmentInput>;
  minimumValidUntil?: string;
}

/** Validate the public wire envelope while retaining the exact authored create input. */
export function parseModelCredentialResolverRequest(value: unknown): ModelCredentialResolverRequest {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "input" && key !== "minimumValidUntil")) {
    throw new Error("Tangle credential request must contain an input and optional validity deadline");
  }
  const request = value as Record<string, unknown>;
  const input = request.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Tangle credential request input must be an object");
  }
  const data = input as Record<string, unknown>;
  const { profile, ...createFields } = data;
  assertBoundedJson(createFields, "Tangle credential request input");
  assertBoundedJson(profile, "Tangle credential request profile", []);
  if ("signal" in data || typeof data.idempotencyKey !== "string" ||
    data.idempotencyKey.length === 0 || data.idempotencyKey.length > 512) {
    throw new Error("Tangle credential request requires a stable create identity without a serialized signal");
  }
  if (!agentProfileSchema.safeParse(data.profile).success || typeof data.profile === "string") {
    throw new Error("Tangle credential request requires an inline AgentProfile");
  }
  // The wire carries JSON. Schema parsing validates it, but must not normalize the caller's profile.
  const acceptedInput = input as CreateAgentEnvironmentInput;
  profileCredentialSource(acceptedInput.profile as Exclude<CreateAgentEnvironmentInput["profile"], string>);
  const deadline = request.minimumValidUntil;
  if (deadline !== undefined && (typeof deadline !== "string" || deadline.length > 128 ||
    !Number.isFinite(new Date(deadline).getTime()))) {
    throw new Error("Tangle credential request validity deadline must be a valid timestamp");
  }
  return { input: acceptedInput, ...(deadline === undefined ? {} : { minimumValidUntil: deadline as string }) };
}

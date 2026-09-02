import { z } from "zod";
import type { Sha256Digest } from "./agent-candidate.js";
import {
  boundedStringSchema,
  confidentialAttestationQuoteSchema,
} from "./contract-limits.js";
import {
  AgentExactRunControlRefSchema,
  type AgentExactRunControlRef,
} from "./runtime-control.js";
import { idSchema, sha256DigestSchema, wireDigest } from "./workspace-branching-shared.js";

/**
 * Evidence for a confidential environment. The signature is retained for an
 * external provider-key check; this package never treats a self-echoed quote
 * as authenticated on its own.
 */
export const ConfidentialAttestationSchema = z
  .strictObject({
    provider: idSchema,
    requested: z.literal(true),
    /** Provider-reported TEE type after external evidence verification. */
    tee: idSchema.optional(),
    /** Verified no-persistence posture, when the provider can prove it. */
    sealed: z.boolean().optional(),
    nonce: idSchema,
    measurement: sha256DigestSchema,
    environmentId: idSchema,
    source: AgentExactRunControlRefSchema,
    requestDigest: sha256DigestSchema,
    profileDigest: sha256DigestSchema,
    policy: idSchema,
    quote: confidentialAttestationQuoteSchema.min(1),
    providerKeyId: idSchema,
    providerSignature: boundedStringSchema.min(1),
    verifiedAt: z.iso.datetime().max(64),
  })
  .superRefine((attestation, refinement) => {
    if (attestation.nonce === attestation.policy) {
      refinement.addIssue({
        code: "custom",
        path: ["nonce"],
        message: "attestation nonce must not reuse the policy identifier",
      });
    }
    if (attestation.providerSignature === attestation.quote) {
      refinement.addIssue({
        code: "custom",
        path: ["providerSignature"],
        message: "provider authentication must not be a copied quote",
      });
    }
  });
export type ConfidentialAttestation = z.infer<
  typeof ConfidentialAttestationSchema
>;

/** What the caller asked for, separate from what the provider proved. */
export const ConfidentialExecutionRequestSchema = z
  .strictObject({
    requested: z.boolean(),
    /** Requested TEE. Omit it to accept any provider-supported TEE. */
    tee: idSchema.optional(),
    /** Require the provider to avoid persistence after the environment ends. */
    sealed: z.boolean().optional(),
    nonce: idSchema.optional(),
    policy: idSchema.optional(),
    profileDigest: sha256DigestSchema.optional(),
  })
  .superRefine((request, refinement) => {
    const carriesAdmissionField =
      request.nonce !== undefined ||
      request.policy !== undefined ||
      request.profileDigest !== undefined;
    const complete =
      request.nonce !== undefined &&
      request.policy !== undefined &&
      request.profileDigest !== undefined;
    if (request.requested && !complete) {
      refinement.addIssue({
        code: "custom",
        path: ["requested"],
        message:
          "a confidential execution request must bind nonce, policy, and profile digest",
      });
    }
    if (
      !request.requested &&
      (carriesAdmissionField ||
        request.tee !== undefined ||
        request.sealed !== undefined)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["requested"],
        message:
          "a non-confidential execution request cannot carry confidential requirements or admission fields",
      });
    }
  });
export type ConfidentialExecutionRequest = z.infer<
  typeof ConfidentialExecutionRequestSchema
>;

function normalizedTeeId(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  switch (normalized) {
    case "aws-nitro":
    case "aws-nitro-enclave":
    case "aws-nitro-enclaves":
      return "nitro";
    case "intel-tdx":
      return "tdx";
    case "amd-sev":
    case "amd-sev-snp":
    case "sev":
      return "sev-snp";
    case "dstack":
    case "phala":
      return "phala-dstack";
    default:
      return normalized;
  }
}

/** Match one requested TEE against a provider-reported TEE identifier. */
export function confidentialTeeMatchesRequest(
  requested: string | undefined,
  attested: string | undefined,
): boolean {
  if (attested === undefined) return requested === undefined;
  const normalizedAttested = normalizedTeeId(attested);
  if (normalizedAttested === "none") return false;
  if (requested === undefined || normalizedTeeId(requested) === "any")
    return true;
  return (
    normalizedAttested === normalizedTeeId(requested)
  );
}

export interface ConfidentialExecutionEnvironment {
  provider: string;
  environmentId: string;
  source: AgentExactRunControlRef;
  requestDigest: Sha256Digest;
  confidentialRequested: boolean;
}

export type ConfidentialAttestationVerifier = (
  attestation: ConfidentialAttestation,
  expected: ConfidentialExecutionEnvironment,
) => boolean;

/**
 * Verify every request/result binding and require an external provider-key
 * check before exposing a positive confidentiality result.
 */
export function confidentialExecutionVerified(input: {
  request: ConfidentialExecutionRequest;
  environment: ConfidentialExecutionEnvironment;
  attestation?: ConfidentialAttestation;
  verifyProviderAttestation?: ConfidentialAttestationVerifier;
}): boolean {
  const parsedRequest = ConfidentialExecutionRequestSchema.safeParse(
    input.request,
  );
  if (!parsedRequest.success || !parsedRequest.data.requested) return false;
  if (input.attestation === undefined || input.verifyProviderAttestation === undefined) {
    return false;
  }
  const parsedEnvironment = z
    .strictObject({
      provider: idSchema,
      environmentId: idSchema,
      source: AgentExactRunControlRefSchema,
      requestDigest: sha256DigestSchema,
      confidentialRequested: z.literal(true),
    })
    .safeParse(input.environment);
  const parsedAttestation = ConfidentialAttestationSchema.safeParse(
    input.attestation,
  );
  if (!parsedEnvironment.success || !parsedAttestation.success) return false;

  const request = parsedRequest.data;
  const environment = parsedEnvironment.data;
  const attestation = parsedAttestation.data;
  if (
    request.nonce === undefined ||
    request.policy === undefined ||
    request.profileDigest === undefined ||
    attestation.requested !== request.requested ||
    attestation.provider !== environment.provider ||
    attestation.environmentId !== environment.environmentId ||
    attestation.source.provider !== environment.source.provider ||
    wireDigest(attestation.source) !== wireDigest(environment.source) ||
    attestation.requestDigest !== environment.requestDigest ||
    attestation.nonce !== request.nonce ||
    attestation.policy !== request.policy ||
    attestation.profileDigest !== request.profileDigest ||
    !confidentialTeeMatchesRequest(request.tee, attestation.tee) ||
    (request.sealed === true && attestation.sealed !== true) ||
    environment.confidentialRequested !== request.requested
  ) {
    return false;
  }
  return input.verifyProviderAttestation(attestation, environment) === true;
}

/** Digest over the complete confidentiality request. */
export function confidentialExecutionRequestDigest(
  request: ConfidentialExecutionRequest,
): Sha256Digest {
  const parsed = ConfidentialExecutionRequestSchema.parse(request);
  return wireDigest({
    requested: parsed.requested,
    ...(parsed.tee === undefined ? {} : { tee: parsed.tee }),
    ...(parsed.sealed === undefined ? {} : { sealed: parsed.sealed }),
    ...(parsed.nonce === undefined ? {} : { nonce: parsed.nonce }),
    ...(parsed.policy === undefined ? {} : { policy: parsed.policy }),
    ...(parsed.profileDigest === undefined
      ? {}
      : { profileDigest: parsed.profileDigest }),
  });
}

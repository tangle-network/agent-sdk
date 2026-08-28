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
    nonce: idSchema.optional(),
    policy: idSchema.optional(),
    profileDigest: sha256DigestSchema.optional(),
  })
  .superRefine((request, refinement) => {
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
    if (!request.requested && complete) {
      refinement.addIssue({
        code: "custom",
        path: ["requested"],
        message:
          "a non-confidential execution request cannot carry confidential admission fields",
      });
    }
  });
export type ConfidentialExecutionRequest = z.infer<
  typeof ConfidentialExecutionRequestSchema
>;

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
    ...(parsed.nonce === undefined ? {} : { nonce: parsed.nonce }),
    ...(parsed.policy === undefined ? {} : { policy: parsed.policy }),
    ...(parsed.profileDigest === undefined
      ? {}
      : { profileDigest: parsed.profileDigest }),
  });
}

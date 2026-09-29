import type { NativeCaptureProofLike, SandboxClientLike, SandboxInstanceLike } from "./tangle-types.js";

const imageId = /^sha256:[0-9a-f]{64}$/;
const containerId = /^[0-9a-f]{64}$/;
const revision = /^[0-9a-f]{40}$/;

function valid(proof: NativeCaptureProofLike | null | undefined): proof is NativeCaptureProofLike {
  return !!proof && typeof proof.hostId === "string" && proof.hostId.length > 0 &&
    containerId.test(proof.containerId) && imageId.test(proof.imageId) &&
    revision.test(proof.bundleRevision) && imageId.test(proof.bundleChecksum);
}

function equal(a: NativeCaptureProofLike, b: NativeCaptureProofLike): boolean {
  return a.hostId === b.hostId && a.containerId === b.containerId &&
    a.imageId === b.imageId && a.bundleRevision === b.bundleRevision &&
    a.bundleChecksum === b.bundleChecksum;
}

/** Require a current host proof; a create must also prove its receipt names that same container. */
export function requireNativeCaptureProof(box: SandboxInstanceLike, create = false): NativeCaptureProofLike {
  const proof = box.captureProof?.();
  if (!valid(proof)) throw new Error("Tangle native session capture has no verified current container proof");
  if (create) {
    const receipt = box.createReceipt?.()?.captureProof;
    if (!valid(receipt) || !equal(proof, receipt)) {
      throw new Error("Tangle native session capture create receipt differs from current container proof");
    }
  }
  return proof;
}

/** Refuse an unsupported deployment before creating a billable sandbox. */
export async function requireNativeCaptureCapability(client: SandboxClientLike): Promise<void> {
  if (!client.evidenceCapabilities ||
      (await client.evidenceCapabilities()).nativeSessionCaptureV1 !== true) {
    throw new Error("Tangle deployment has not proven native session capture for next-create placement");
  }
}

import {
  ContextTransferRequestSchema,
  ContextTransferResultSchema,
  NativeContextBoundaryProofSchema,
  NativeContextContinuationAcknowledgementSchema,
  NativeContextContinuationRequestSchema,
  PortableContextPlanRequestSchema,
  PortableContextPlanResultSchema,
  contextTransferRequestDigest,
  contextTransferResultMatchesRequest,
  contextTransferReceiptMatches,
  nativeContextContinuationAcknowledgementMatches,
  nativeContextContinuationRequestDigest,
  nativeContextContinuationTurnDigest,
  portableContextPlanResultMatchesRequest,
} from "@tangle-network/agent-interface";
import type {
  PortableContextConformanceOptions,
  PortableContextConformanceReport,
} from "./conformance-types.js";
import {
  assertNoContextEffects,
  assertPortablePlanCoversRequest,
  differentBoundary,
} from "./portable-context-helpers.js";
import { assert, deepEqual } from "./conformance-helpers.js";

export async function runPortableContextConformance(
  options: PortableContextConformanceOptions,
): Promise<PortableContextConformanceReport> {
  const checked: string[] = [];
  const request = PortableContextPlanRequestSchema.parse(options.request);
  const before = await options.counters();
  const result = PortableContextPlanResultSchema.parse(
    await options.plan(request),
  );
  const afterPlan = await options.counters();
  assert(
    afterPlan.plans === before.plans + 1,
    "context planning counter must advance once",
    checked,
  );
  assertNoContextEffects(before, afterPlan, checked);
  assert(result.status === "ready", "context conformance requires a ready plan", checked);
  assert(
    portableContextPlanResultMatchesRequest(request, result),
    "ready context plan does not match its request or token budget",
    checked,
  );
  assertPortablePlanCoversRequest(request, result, checked);
  checked.push("side-effect-free-plan");

  const rejectionRequest = PortableContextPlanRequestSchema.parse(
    options.rejectionRequest,
  );
  assert(
    rejectionRequest.requestId !== request.requestId &&
      rejectionRequest.maxInputTokens !== undefined,
    "over-limit conformance requires a distinct request with a token budget",
    checked,
  );
  const rejection = PortableContextPlanResultSchema.parse(
    await options.plan(rejectionRequest),
  );
  assert(
    rejection.status === "over_limit" &&
      portableContextPlanResultMatchesRequest(rejectionRequest, rejection),
    "oversized context must return an exact over-limit result",
    checked,
  );
  assert(
    !portableContextPlanResultMatchesRequest(request, rejection) &&
      !portableContextPlanResultMatchesRequest(rejectionRequest, result),
    "context planning results must not match a different request",
    checked,
  );
  const afterRejection = await options.counters();
  assert(
    afterRejection.plans === afterPlan.plans + 1,
    "over-limit planning counter must advance once",
    checked,
  );
  assertNoContextEffects(before, afterRejection, checked);
  checked.push("rejected-plan-zero-dispatch");

  const mismatchedTransferMaterial = {
    operationId: `${request.requestId}-mismatch`,
    plan: result.plan,
    acceptance: {
      planDigest: request.source.digest,
      acceptedAt: options.acceptedAt,
      acceptedBy: "user" as const,
    },
  };
  const mismatchedTransfer = {
    requestDigest: contextTransferRequestDigest(mismatchedTransferMaterial),
    ...mismatchedTransferMaterial,
  };
  assert(
    !ContextTransferRequestSchema.safeParse(mismatchedTransfer).success,
    "mismatched plan digest must fail before transfer",
    checked,
  );
  assertNoContextEffects(before, await options.counters(), checked);
  checked.push("mismatched-plan-zero-dispatch");

  const transferMaterial = {
    operationId: `${request.requestId}-transfer`,
    plan: result.plan,
    acceptance: {
      planDigest: result.plan.digest,
      acceptedAt: options.acceptedAt,
      acceptedBy: "user" as const,
    },
  };
  const transferRequest = ContextTransferRequestSchema.parse({
    requestDigest: contextTransferRequestDigest(transferMaterial),
    ...transferMaterial,
  });
  const receipt = ContextTransferResultSchema.parse(
    await options.transfer(transferRequest),
  );
  assert(
    receipt.status === "accepted" &&
      contextTransferResultMatchesRequest(transferRequest, receipt) &&
      contextTransferReceiptMatches(transferRequest, receipt),
    "context transfer receipt does not match the accepted plan",
    checked,
  );
  const afterTransfer = await options.counters();
  assert(
    afterTransfer.transfers === before.transfers + 1 &&
      afterTransfer.freshSessions === before.freshSessions + 1,
    "accepted context must dispatch once into one fresh session",
    checked,
  );
  checked.push("accepted-transfer-receipt");

  const replayedTransfer = ContextTransferResultSchema.parse(
    await options.transfer(transferRequest),
  );
  assert(
    replayedTransfer.status === "replayed" &&
      contextTransferResultMatchesRequest(transferRequest, replayedTransfer) &&
      contextTransferReceiptMatches(transferRequest, replayedTransfer) &&
      replayedTransfer.environmentId === receipt.environmentId &&
      replayedTransfer.sessionId === receipt.sessionId,
    "context transfer retry must recover the original fresh session",
    checked,
  );
  assert(
    deepEqual(await options.counters(), afterTransfer),
    "context transfer retry must create no second session",
    checked,
  );
  const changedTransferMaterial = {
    ...transferMaterial,
    acceptance: { ...transferMaterial.acceptance, acceptedBy: "policy" as const },
  };
  const changedTransfer = ContextTransferRequestSchema.parse({
    requestDigest: contextTransferRequestDigest(changedTransferMaterial),
    ...changedTransferMaterial,
  });
  const transferConflict = ContextTransferResultSchema.parse(
    await options.transfer(changedTransfer),
  );
  assert(
    transferConflict.status === "conflict" &&
      contextTransferResultMatchesRequest(changedTransfer, transferConflict) &&
      transferConflict.existingRequestDigest === transferRequest.requestDigest,
    "changed transfer input must conflict with the original operation",
    checked,
  );
  assert(
    deepEqual(await options.counters(), afterTransfer),
    "context transfer conflict must dispatch nothing",
    checked,
  );
  checked.push("transfer-replay-conflict");

  const proof = NativeContextBoundaryProofSchema.parse(
    await options.boundary(options.run),
  );
  const continuationMaterial = {
    operationId: `${request.requestId}-continue`,
    turnDigest: nativeContextContinuationTurnDigest({ prompt: "continue" }),
    run: options.run,
    expectedBoundary: proof,
  };
  const continuation = NativeContextContinuationRequestSchema.parse({
    requestDigest: nativeContextContinuationRequestDigest(
      continuationMaterial,
    ),
    ...continuationMaterial,
  });
  const mismatchedBoundary = {
    ...proof,
    boundary: differentBoundary(proof.boundary),
  };
  const mismatchMaterial = {
    operationId: `${continuation.operationId}-mismatch`,
    turnDigest: continuation.turnDigest,
    run: options.run,
    expectedBoundary: mismatchedBoundary,
  };
  const mismatch = NativeContextContinuationRequestSchema.parse({
    requestDigest: nativeContextContinuationRequestDigest(mismatchMaterial),
    ...mismatchMaterial,
  });
  const mismatchAck = NativeContextContinuationAcknowledgementSchema.parse(
    await options.continueNative(mismatch),
  );
  assert(
    mismatchAck.status === "boundary_mismatch" &&
      !nativeContextContinuationAcknowledgementMatches(mismatch, mismatchAck),
    "changed native boundary must be rejected",
    checked,
  );
  assert(
    (await options.counters()).nativeContinuations === before.nativeContinuations,
    "boundary mismatch must dispatch no continuation",
    checked,
  );
  checked.push("continuation-boundary-rejection");

  const continuationAck = NativeContextContinuationAcknowledgementSchema.parse(
    await options.continueNative(continuation),
  );
  assert(
    continuationAck.status === "accepted" &&
      nativeContextContinuationAcknowledgementMatches(
        continuation,
        continuationAck,
      ) &&
      continuationAck.historyMessagesSent === 0,
    "matching native continuation must send no duplicate history",
    checked,
  );
  assert(
    (await options.counters()).nativeContinuations ===
      before.nativeContinuations + 1,
    "matching native boundary must continue exactly once",
    checked,
  );
  checked.push("verified-native-continuation");

  const afterContinuation = await options.counters();
  const replayedContinuation =
    NativeContextContinuationAcknowledgementSchema.parse(
      await options.continueNative(continuation),
    );
  assert(
    replayedContinuation.status === "replayed" &&
      nativeContextContinuationAcknowledgementMatches(
        continuation,
        replayedContinuation,
      ),
    "native continuation retry must recover the original operation",
    checked,
  );
  assert(
    deepEqual(await options.counters(), afterContinuation),
    "native continuation retry must dispatch nothing",
    checked,
  );
  const changedProof = {
    ...proof,
    observedAt: new Date(Date.parse(proof.observedAt) + 1).toISOString(),
  };
  const changedContinuationMaterial = {
    operationId: continuation.operationId,
    turnDigest: continuation.turnDigest,
    run: options.run,
    expectedBoundary: changedProof,
  };
  const changedContinuation = NativeContextContinuationRequestSchema.parse({
    requestDigest: nativeContextContinuationRequestDigest(
      changedContinuationMaterial,
    ),
    ...changedContinuationMaterial,
  });
  const continuationConflict =
    NativeContextContinuationAcknowledgementSchema.parse(
      await options.continueNative(changedContinuation),
    );
  assert(
    continuationConflict.status === "conflict" &&
      continuationConflict.existingRequestDigest ===
        continuation.requestDigest &&
      !nativeContextContinuationAcknowledgementMatches(
        changedContinuation,
        continuationConflict,
      ),
    "changed continuation input must conflict with the original operation",
    checked,
  );
  assert(
    deepEqual(await options.counters(), afterContinuation),
    "native continuation conflict must dispatch nothing",
    checked,
  );
  checked.push("continuation-replay-conflict");

  return {
    name: options.name,
    planDigest: result.plan.digest,
    contextDigest: result.plan.context.digest,
    checked,
  };
}

/** Prove retry recovery, changed-input conflicts, and confirmed cleanup. */

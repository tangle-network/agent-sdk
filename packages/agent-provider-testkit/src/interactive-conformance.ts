import {
  AgentInteractiveSessionAttachSchema,
  AgentInteractiveSessionControlClaimSchema,
  AgentInteractiveSessionControlClaimAcknowledgementSchema,
  AgentInteractiveSessionControlClaimRequestSchema,
  AgentInteractiveSessionPromptAcknowledgementSchema,
  AgentInteractiveSessionPromptCommandSchema,
  AgentInteractiveSessionRefSchema,
  AgentInteractiveSessionStopAcknowledgementSchema,
  AgentInteractiveSessionStopCommandSchema,
  agentInteractiveSessionControlClaimRequestDigest,
  agentInteractiveSessionPromptRequestDigest,
  agentInteractiveSessionStopRequestDigest,
  canonicalCandidateDigest,
} from "@tangle-network/agent-interface";
import type {
  AgentInteractiveSessionControlClaim,
  AgentInteractiveSessionPromptCommand,
  AgentInteractiveSessionRef,
  AgentInteractiveSessionStopCommand,
} from "@tangle-network/agent-interface";
import type {
  InteractiveSessionConformanceOptions,
  InteractiveSessionConformanceReport,
} from "./conformance-types.js";
import { assert, deepEqual } from "./conformance-helpers.js";

/**
 * Prove exact interactive replay, operation replay, and stale-controller fencing.
 *
 * The provider owns the durable records. The testkit deliberately repeats the
 * same commands after the first acknowledgement to model a lost response.
 */
export async function runInteractiveSessionConformance(
  options: InteractiveSessionConformanceOptions,
): Promise<InteractiveSessionConformanceReport> {
  const checked: string[] = [];
  const initialStarts = await options.startCount();
  const request = options.request;
  const first = AgentInteractiveSessionRefSchema.parse(
    await options.start(request),
  );
  const afterFirstStart = await options.startCount();
  assert(
    afterFirstStart === initialStarts + 1,
    "the first exact interactive start must create one process",
    checked,
  );
  assert(
    first.preparationReceipt.authoredProfileDigest ===
      request.requestedProfileDigest,
    "the interactive receipt must bind the requested profile",
    checked,
  );
  assert(
    first.preparationReceipt.harness === request.profile.harness &&
      first.preparationReceipt.backend.length > 0 &&
      first.preparationReceipt.harnessVersion.length > 0 &&
      first.preparationReceipt.resolvedModel.resolved.length > 0,
    "the interactive receipt must expose the admitted route",
    checked,
  );
  checked.push("start-admission");

  const runningReplay = AgentInteractiveSessionRefSchema.parse(
    await options.start(request),
  );
  assert(
    deepEqual(runningReplay, first),
    "an exact running start must return the same ref and receipt",
    checked,
  );
  assert(
    (await options.startCount()) === afterFirstStart,
    "an exact running replay must not create another process",
    checked,
  );
  checked.push("start-replay-running");

  assert(
    deepEqual(options.changedRequest.run, request.run) &&
      !deepEqual(options.changedRequest, request),
    "changed start material must reuse the exact run for the conflict check",
    checked,
  );
  assertReject(
    () => options.start(options.changedRequest),
    "changed interactive material must conflict",
    checked,
  );
  assert(
    (await options.startCount()) === afterFirstStart,
    "a changed start must not create another process",
    checked,
  );
  checked.push("changed-start-conflict");

  const session = options.interactive(first);
  const initialControlGeneration = options.initialControlGeneration ?? 0;
  if (initialControlGeneration > 0) {
    const launchGenerationProbe = claimRequest(
      first,
      `${options.name}-launch-generation-probe`,
      `${options.name}-coordinator-probe`,
      0,
    );
    const launchGenerationConflict =
      AgentInteractiveSessionControlClaimAcknowledgementSchema.parse(
        await session.claimControl(launchGenerationProbe),
      );
    assert(
      launchGenerationConflict.status === "conflict" &&
        launchGenerationConflict.conflictReason === "generation_mismatch" &&
        launchGenerationConflict.currentGeneration === initialControlGeneration,
      "a launch control generation must reject zero as stale",
      checked,
    );
    checked.push("launch-generation-fence");
  }
  const initialClaimRequest = claimRequest(
    first,
    `${options.name}-claim-operation`,
    `${options.name}-coordinator-1`,
    initialControlGeneration,
  );
  const firstClaim = AgentInteractiveSessionControlClaimAcknowledgementSchema.parse(
    await session.claimControl(initialClaimRequest),
  );
  assert(
    firstClaim.status === "accepted" && firstClaim.control !== undefined,
    "the first control claim must be accepted with a claim",
    checked,
  );
  const control = firstClaim.control!;
  checked.push("control-claim-accepted");

  const claimReplay = AgentInteractiveSessionControlClaimAcknowledgementSchema.parse(
    await session.claimControl(initialClaimRequest),
  );
  assert(
    claimReplay.status === "replayed" &&
      deepEqual(claimReplay.control, control),
    "retrying a claim after losing its response must replay the same claim",
    checked,
  );
  checked.push("claim-replay-after-lost-response");

  const staleTakeoverRequest = claimRequest(
    first,
    `${options.name}-stale-takeover`,
    `${options.name}-coordinator-2`,
    0,
  );
  const staleTakeover = AgentInteractiveSessionControlClaimAcknowledgementSchema.parse(
    await session.claimControl(staleTakeoverRequest),
  );
  assert(
    staleTakeover.status === "conflict" &&
      staleTakeover.conflictReason === "generation_mismatch" &&
      staleTakeover.currentGeneration === control.generation,
    "a stale compare-and-swap takeover must report generation mismatch",
    checked,
  );
  checked.push("stale-takeover-rejection");

  const reusedClaimRequest = claimRequest(
    first,
    initialClaimRequest.operationId,
    `${options.name}-different-holder`,
    0,
  );
  const reusedClaim = AgentInteractiveSessionControlClaimAcknowledgementSchema.parse(
    await session.claimControl(reusedClaimRequest),
  );
  assert(
    reusedClaim.status === "conflict" &&
      reusedClaim.conflictReason === "operation_reuse" &&
      reusedClaim.existingRequestDigest === initialClaimRequest.requestDigest,
    "reusing an operation id with changed material must report operation reuse",
    checked,
  );
  checked.push("claim-operation-conflict");

  const prompt = promptCommand(
    first,
    control,
    `${options.name}-prompt-operation`,
    options.prompt ?? "Return the word ok.",
  );
  const sendPrompt = session.sendPrompt;
  assert(
    typeof sendPrompt === "function",
    "the exact interactive session must expose typed prompt delivery",
    checked,
  );
  const acceptedPrompt = AgentInteractiveSessionPromptAcknowledgementSchema.parse(
    await sendPrompt!(prompt),
  );
  assert(
    acceptedPrompt.status === "accepted",
    "the first exact prompt operation must be accepted",
    checked,
  );
  const replayedPrompt = AgentInteractiveSessionPromptAcknowledgementSchema.parse(
    await sendPrompt!(prompt),
  );
  assert(
    replayedPrompt.status === "replayed" &&
      replayedPrompt.requestDigest === prompt.requestDigest,
    "retrying a prompt after losing its response must replay the acknowledgement",
    checked,
  );
  checked.push("prompt-replay-after-lost-response");

  const changedPrompt = promptCommand(
    first,
    control,
    prompt.operationId,
    options.changedPrompt ?? "Perform a different paid action.",
  );
  const promptConflict = AgentInteractiveSessionPromptAcknowledgementSchema.parse(
    await sendPrompt!(changedPrompt),
  );
  assert(
    promptConflict.status === "conflict" &&
      promptConflict.existingRequestDigest === prompt.requestDigest,
    "the same prompt operation id with changed material must conflict",
    checked,
  );
  checked.push("prompt-operation-conflict");

  const staleRef = AgentInteractiveSessionRefSchema.parse({
    ...first,
    incarnationId: `${first.incarnationId}-stale`,
  });
  const staleControl = AgentInteractiveSessionControlClaimSchema.parse({
    ...control,
    refDigest: canonicalCandidateDigest(staleRef),
    leaseId: `${control.leaseId}-stale`,
  });
  const stalePrompt = promptCommand(
    staleRef,
    staleControl,
    `${options.name}-stale-prompt`,
    "This must not reach the stale process.",
  );
  assertReject(
    () => options.interactive(staleRef).sendPrompt!(stalePrompt),
    "a prompt for a stale process incarnation must be rejected",
    checked,
  );
  checked.push("stale-incarnation-prompt-rejection");

  const expiredControl = AgentInteractiveSessionControlClaimSchema.parse({
    ...control,
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
  assertReject(
    () => session.attach(AgentInteractiveSessionAttachSchema.parse({ control: expiredControl })),
    "an expired claim must not attach a terminal",
    checked,
  );
  const terminal = await session.attach({ control });
  await terminal.input({ data: "y" });
  await terminal.resize({ cols: 100, rows: 32 });
  checked.push("terminal-mutations-with-current-control");

  const recoveryRequest = claimRequest(
    first,
    `${options.name}-recovery-operation`,
    `${options.name}-coordinator-2`,
    control.generation,
  );
  const recovered = AgentInteractiveSessionControlClaimAcknowledgementSchema.parse(
    await session.claimControl(recoveryRequest),
  );
  assert(
    recovered.status === "accepted" && recovered.control !== undefined,
    "a recovered coordinator must claim the next generation",
    checked,
  );
  const recoveredControl = recovered.control!;

  await assertReject(
    () => terminal.input({ data: "stale" }),
    "a stale claim must reject terminal input",
    checked,
  );
  await assertReject(
    () => terminal.resize({ cols: 90, rows: 30 }),
    "a stale claim must reject terminal resize",
    checked,
  );
  checked.push("stale-terminal-mutation-rejection");

  await terminal.close();
  checked.push("stale-terminal-socket-close");

  await assertReject(
    () => session.attach({ control }),
    "a stale claim must reject terminal attach",
    checked,
  );
  const recoveredTerminal = await session.attach({ control: recoveredControl });
  await recoveredTerminal.close();
  checked.push("stale-attach-rejection");

  const staleStop = stopCommand(
    first,
    control,
    `${options.name}-stale-stop`,
  );
  await assertReject(
    () => session.stop(staleStop),
    "a stale claim must reject stop",
    checked,
  );
  checked.push("stale-stop-rejection");

  const stop = stopCommand(
    first,
    recoveredControl,
    `${options.name}-stop-operation`,
  );
  const stopped = AgentInteractiveSessionStopAcknowledgementSchema.parse(
    await session.stop(stop),
  );
  assert(
    stopped.status === "accepted" && stopped.effect !== "unknown",
    "the exact stop operation must return an acknowledged effect",
    checked,
  );
  checked.push("stop-accepted");

  const exitedReplay = AgentInteractiveSessionRefSchema.parse(
    await options.start(request),
  );
  assert(
    deepEqual(exitedReplay, first),
    "an exact start after exit must return the same ref and incarnation",
    checked,
  );
  assert(
    (await options.startCount()) === afterFirstStart,
    "an exited start replay must not create another process",
    checked,
  );
  checked.push("start-replay-exited");

  return {
    name: options.name,
    ref: first,
    promptOperationId: prompt.operationId,
    checked,
  };
}

function claimRequest(
  ref: AgentInteractiveSessionRef,
  operationId: string,
  holderId: string,
  expectedGeneration: number,
) {
  const material = { operationId, ref, holderId, expectedGeneration };
  return AgentInteractiveSessionControlClaimRequestSchema.parse({
    ...material,
    requestDigest: agentInteractiveSessionControlClaimRequestDigest(material),
  });
}

function promptCommand(
  ref: AgentInteractiveSessionRef,
  control: AgentInteractiveSessionControlClaim,
  operationId: string,
  prompt: string,
): AgentInteractiveSessionPromptCommand {
  const material = { operationId, ref, control, prompt };
  return AgentInteractiveSessionPromptCommandSchema.parse({
    ...material,
    requestDigest: agentInteractiveSessionPromptRequestDigest(material),
  });
}

function stopCommand(
  ref: AgentInteractiveSessionRef,
  control: AgentInteractiveSessionControlClaim,
  operationId: string,
): AgentInteractiveSessionStopCommand {
  const material = { operationId, ref, control };
  return AgentInteractiveSessionStopCommandSchema.parse({
    ...material,
    requestDigest: agentInteractiveSessionStopRequestDigest(material),
  });
}

async function assertReject(
  operation: () => Promise<unknown>,
  message: string,
  checked: string[],
): Promise<void> {
  let rejected = false;
  try {
    await operation();
  } catch {
    rejected = true;
  }
  assert(rejected, message, checked);
}

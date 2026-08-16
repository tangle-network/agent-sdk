import {
  AgentInteractiveSessionPromptAcknowledgementSchema,
  AgentInteractiveSessionPromptCommandSchema,
  AgentInteractiveSessionRefSchema,
  agentInteractiveSessionControlClaimMatchesRef,
  agentInteractiveSessionPromptRequestDigest,
  canonicalCandidateDigest,
} from "@tangle-network/agent-interface";
import type {
  AgentInteractiveSessionPromptCommand,
  AgentInteractiveSessionRef,
} from "@tangle-network/agent-interface";
import type {
  InteractiveSessionConformanceOptions,
  InteractiveSessionConformanceReport,
} from "./conformance-types.js";
import { assert, deepEqual } from "./conformance-helpers.js";

/**
 * Prove exact interactive replay, prompt idempotency, and stale-controller fencing.
 *
 * The adapter supplies a start counter so this check proves that a replay did not
 * create another process. The first prompt acknowledgement is deliberately
 * discarded before the same command is retried.
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
    "interactive ref preparation must name the requested profile",
    checked,
  );
  assert(
    first.preparationReceipt.harness === request.profile.harness,
    "interactive ref preparation must name the requested harness",
    checked,
  );
  assert(
    first.preparationReceipt.backend.length > 0 &&
      first.preparationReceipt.harnessVersion.length > 0 &&
      first.preparationReceipt.resolvedModel.resolved.length > 0,
    "interactive ref preparation must expose the admitted route",
    checked,
  );
  checked.push("start-admission");

  const runningReplay = AgentInteractiveSessionRefSchema.parse(
    await options.start(request),
  );
  assert(
    deepEqual(runningReplay, first),
    "repeating an exact interactive start must return the same ref while running",
    checked,
  );
  assert(
    (await options.startCount()) === afterFirstStart,
    "repeating an exact interactive start must not create another process",
    checked,
  );
  checked.push("start-replay-running");

  assert(
    deepEqual(options.changedRequest.run, request.run),
    "changed interactive material must reuse the exact run for the conflict check",
    checked,
  );
  assert(
    !deepEqual(options.changedRequest, request),
    "changed interactive conflict input must change start material",
    checked,
  );
  let changedRejected = false;
  try {
    await options.start(options.changedRequest);
  } catch {
    changedRejected = true;
  }
  assert(
    changedRejected,
    "changed interactive material must not reuse an exact run",
    checked,
  );
  assert(
    (await options.startCount()) === afterFirstStart,
    "a changed interactive request must not create a process",
    checked,
  );
  checked.push("changed-start-conflict");

  const session = options.interactive(first);
  assert(
    typeof session.claimControl === "function",
    "interactive sessions must expose control claiming",
    checked,
  );
  const control = await session.claimControl({
    holderId: `${options.name}-coordinator`,
  });
  assert(
    agentInteractiveSessionControlClaimMatchesRef(first, control),
    "claimed interactive control must bind to the exact process ref",
    checked,
  );
  checked.push("control-claim");

  assert(
    typeof session.sendPrompt === "function",
    "interactive prompt capability must expose sendPrompt()",
    checked,
  );
  const promptOperationId = `${options.name}-prompt-operation`;
  const promptMaterial = {
    operationId: promptOperationId,
    ref: first,
    control,
    prompt: options.prompt ?? "Return the word ok.",
  };
  const prompt = AgentInteractiveSessionPromptCommandSchema.parse({
    ...promptMaterial,
    requestDigest: agentInteractiveSessionPromptRequestDigest(promptMaterial),
  });
  const accepted = AgentInteractiveSessionPromptAcknowledgementSchema.parse(
    await session.sendPrompt!(prompt),
  );
  assert(
    accepted.status === "accepted",
    "the first exact prompt operation must be accepted",
    checked,
  );
  checked.push("prompt-accepted");

  const replayed = AgentInteractiveSessionPromptAcknowledgementSchema.parse(
    await session.sendPrompt!(prompt),
  );
  assert(
    replayed.status === "replayed" &&
      replayed.requestDigest === prompt.requestDigest,
    "retrying a prompt after losing its acknowledgement must replay the result",
    checked,
  );
  checked.push("prompt-replay-after-lost-response");

  const changedPromptMaterial = {
    ...promptMaterial,
    prompt: options.changedPrompt ?? "Perform a different paid action.",
  };
  const changedPrompt = AgentInteractiveSessionPromptCommandSchema.parse({
    ...changedPromptMaterial,
    requestDigest: agentInteractiveSessionPromptRequestDigest(
      changedPromptMaterial,
    ),
  });
  const conflict = AgentInteractiveSessionPromptAcknowledgementSchema.parse(
    await session.sendPrompt!(changedPrompt),
  );
  assert(
    conflict.status === "conflict" &&
      conflict.existingRequestDigest === prompt.requestDigest,
    "the same prompt operation id with changed material must conflict",
    checked,
  );
  checked.push("prompt-operation-conflict");

  const staleRef: AgentInteractiveSessionRef = AgentInteractiveSessionRefSchema.parse({
    ...first,
    incarnationId: `${first.incarnationId}-stale`,
  });
  const staleControl = {
    ...control,
    refDigest: canonicalCandidateDigest(staleRef),
    leaseId: `${control.leaseId}-stale`,
  };
  const staleMaterial = {
    operationId: `${promptOperationId}-stale`,
    ref: staleRef,
    control: staleControl,
    prompt: "This must not reach the stale process.",
  };
  const stalePrompt: AgentInteractiveSessionPromptCommand =
    AgentInteractiveSessionPromptCommandSchema.parse({
      ...staleMaterial,
      requestDigest: agentInteractiveSessionPromptRequestDigest(staleMaterial),
    });
  let staleRejected = false;
  try {
    await options.interactive(staleRef).sendPrompt!(stalePrompt);
  } catch {
    staleRejected = true;
  }
  assert(
    staleRejected,
    "a prompt for a stale process incarnation must be rejected",
    checked,
  );
  checked.push("stale-incarnation-prompt-rejection");

  const stopped = await session.stop({ control });
  assert(
    stopped.state === "exited",
    "stopping an exact interactive process must confirm its terminal state",
    checked,
  );
  checked.push("stop-with-control");

  const exitedReplay = AgentInteractiveSessionRefSchema.parse(
    await options.start(request),
  );
  assert(
    deepEqual(exitedReplay, first),
    "repeating an exact interactive start after exit must return the same ref",
    checked,
  );
  assert(
    (await options.startCount()) === afterFirstStart,
    "replaying an exited exact interactive start must not create another process",
    checked,
  );
  checked.push("start-replay-exited");

  return {
    name: options.name,
    ref: first,
    promptOperationId,
    checked,
  };
}

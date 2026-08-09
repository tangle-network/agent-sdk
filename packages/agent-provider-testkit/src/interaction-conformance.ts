import {
  InteractionAcknowledgementSchema,
  InteractionRequestSchema,
  InteractionResponseCommandSchema,
  interactionResponseCommandDigest,
  validateInteractionResponse,
  type InteractionAcknowledgement,
  type InteractionResponseCommand,
} from "@tangle-network/agent-interface";
import type {
  InteractionResponseConformanceOptions,
  InteractionResponseConformanceReport,
} from "./conformance-types.js";
import { assert, deepEqual } from "./conformance-helpers.js";

export async function runInteractionResponseConformance(
  options: InteractionResponseConformanceOptions,
): Promise<InteractionResponseConformanceReport> {
  const checked: string[] = [];
  const request = InteractionRequestSchema.parse(options.request);
  const command = InteractionResponseCommandSchema.parse(options.command);
  assert(
    request.id === command.binding.interactionId,
    "prepared request differs from the command binding",
    checked,
  );
  assert(
    validateInteractionResponse(request, command.response).ok,
    "prepared interaction response is invalid",
    checked,
  );

  const expectStatus = async (
    candidate: InteractionResponseCommand,
    status: InteractionAcknowledgement["status"],
  ): Promise<InteractionAcknowledgement> => {
    const acknowledgement = InteractionAcknowledgementSchema.parse(
      await options.respond(candidate),
    );
    assert(
      acknowledgement.status === status,
      `expected interaction status ${status}, received ${acknowledgement.status}`,
      checked,
    );
    assert(
      acknowledgement.operationId === candidate.operationId,
      "interaction acknowledgement operation id differs",
      checked,
    );
    assert(
      deepEqual(acknowledgement.binding, candidate.binding),
      "interaction acknowledgement binding differs",
      checked,
    );
    assert(
      acknowledgement.commandDigest === candidate.commandDigest,
      "interaction acknowledgement command digest differs",
      checked,
    );
    return acknowledgement;
  };

  await expectStatus(
    withCommandDigest({
      ...command,
      operationId: `${command.operationId}-wrong-run`,
      binding: { ...command.binding, runId: `${command.binding.runId}-wrong` },
    }),
    "unknown_run",
  );
  await expectStatus(
    withCommandDigest({
      ...command,
      operationId: `${command.operationId}-wrong-environment`,
      binding: {
        ...command.binding,
        environmentId: `${command.binding.environmentId}-wrong`,
      },
    }),
    "binding_mismatch",
  );
  if (command.binding.sessionId) {
    await expectStatus(
      withCommandDigest({
        ...command,
        operationId: `${command.operationId}-wrong-session`,
        binding: {
          ...command.binding,
          sessionId: `${command.binding.sessionId}-wrong`,
        },
      }),
      "binding_mismatch",
    );
  }
  const wrongInteractionId = `${command.binding.interactionId}-wrong`;
  await expectStatus(
    withCommandDigest({
      ...command,
      operationId: `${command.operationId}-wrong-interaction`,
      binding: { ...command.binding, interactionId: wrongInteractionId },
      response: { ...command.response, id: wrongInteractionId },
    }),
    "unknown_interaction",
  );
  checked.push("wrong-bindings");

  assert(
    command.response.outcome === "accepted",
    "interaction conformance requires an accepted response with data",
    checked,
  );
  await expectStatus(
    withCommandDigest({
      ...command,
      operationId: `${command.operationId}-invalid-response`,
      response: {
        ...command.response,
        data: {
          ...(command.response.data ?? {}),
          "testkit-undeclared-field": "must be rejected",
        },
      },
    }),
    "invalid_response",
  );
  checked.push("invalid-response");

  const accepted = await expectStatus(command, "accepted");
  checked.push("accepted");

  const replayed = await expectStatus(command, "accepted");
  assert(
    deepEqual(replayed, accepted),
    "same interaction operation must return the same acknowledgement",
    checked,
  );
  checked.push("operation-replay");

  await expectStatus(
    { ...command, operationId: `${command.operationId}-same-response` },
    "already_resolved_same",
  );
  checked.push("same-response");

  const changedResponse = withCommandDigest({
    ...command,
    operationId: `${command.operationId}-different-response`,
    response: {
      id: command.response.id,
      outcome: "declined" as const,
    },
  });
  await expectStatus(changedResponse, "already_resolved_different");
  await expectStatus(
    { ...changedResponse, operationId: command.operationId },
    "already_resolved_different",
  );
  checked.push("different-response-conflict");

  assert(
    options.statusCases.length === 3,
    "interaction conformance requires exactly three prepared status cases",
    checked,
  );
  for (const expectedStatus of [
    "expired",
    "cancelled",
    "transport_failure",
  ] as const) {
    const prepared = options.statusCases.filter(
      (candidate) => candidate.expectedStatus === expectedStatus,
    );
    assert(
      prepared.length === 1,
      `interaction conformance requires exactly one ${expectedStatus} case`,
      checked,
    );
    const statusCase = prepared[0]!;
    const statusRequest = InteractionRequestSchema.parse(statusCase.request);
    const statusCommand = InteractionResponseCommandSchema.parse(statusCase.command);
    assert(
      statusRequest.id === statusCommand.binding.interactionId &&
        validateInteractionResponse(statusRequest, statusCommand.response).ok,
      `${expectedStatus} case must contain a valid bound response`,
      checked,
    );
    const acknowledgement = await expectStatus(
      statusCommand,
      expectedStatus,
    );
    if (expectedStatus === "transport_failure") {
      assert(
        acknowledgement.message !== undefined &&
          acknowledgement.retryable !== undefined,
        "transport failure must explain whether retry is safe",
        checked,
      );
    }
    checked.push(expectedStatus);
  }

  return { name: options.name, checked };
}

function withCommandDigest(
  command: Omit<InteractionResponseCommand, "commandDigest"> | InteractionResponseCommand,
): InteractionResponseCommand {
  return {
    ...command,
    commandDigest: interactionResponseCommandDigest(command),
  };
}

/** Prove planning purity, digest-bound fresh transfer, and verified continuation. */

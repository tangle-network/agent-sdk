import {
  InteractionAcknowledgementSchema,
  InteractionResponseCommandSchema,
} from "@tangle-network/agent-interface";
import type {
  InteractionAcknowledgement,
  InteractionResponseCommand,
} from "@tangle-network/agent-interface";
import type { CliBridgeProviderOptions } from "./provider-options.js";
import {
  MAX_CLI_BRIDGE_CONTROL_RESPONSE_BYTES,
  readBoundedCliBridgeResponse,
  requestHeaders,
  trimSlash,
  type CliBridgeTransport,
} from "./transport.js";

interface CliBridgeInteractionResponderOptions {
  readonly sessionId?: string;
  readonly providerName: string;
  readonly environmentId: string;
  readonly options: CliBridgeProviderOptions;
  readonly transport: CliBridgeTransport;
}

function transportFailure(
  command: InteractionResponseCommand,
  error: unknown,
  retryable = true,
): InteractionAcknowledgement {
  return InteractionAcknowledgementSchema.parse({
    operationId: command.operationId,
    binding: command.binding,
    commandDigest: command.commandDigest,
    status: "transport_failure",
    message: `cli-bridge did not confirm the interaction response: ${
      error instanceof Error ? error.message : String(error)
    }`,
    retryable,
  });
}

function expectedHttpStatus(status: InteractionAcknowledgement["status"]): number {
  if (status === "accepted" || status === "already_resolved_same") return 200;
  if (status === "invalid_response") return 400;
  if (status === "unknown_run" || status === "unknown_interaction") return 404;
  if (
    status === "already_resolved_different" ||
    status === "expired" ||
    status === "cancelled" ||
    status === "binding_mismatch"
  ) return 409;
  return 502;
}

function matchesHttpStatus(
  acknowledgement: InteractionAcknowledgement,
  status: number,
): boolean {
  if (status === expectedHttpStatus(acknowledgement.status)) return true;

  // Bridge uses 429 only for a retryable rejection before the response can take effect.
  return (
    status === 429 &&
    acknowledgement.status === "transport_failure" &&
    acknowledgement.retryable === true
  );
}

function classifyAcknowledgement(
  acknowledgement: InteractionAcknowledgement,
  status: number,
): InteractionAcknowledgement {
  if (!matchesHttpStatus(acknowledgement, status)) {
    throw new Error(
      `cli-bridge interaction acknowledgement status ${JSON.stringify(acknowledgement.status)} contradicts HTTP ${status}`,
    );
  }
  if (status >= 400 && status < 500 && acknowledgement.retryable === undefined) {
    return { ...acknowledgement, retryable: false };
  }
  return acknowledgement;
}

function assertAcknowledgesCommand(
  acknowledgement: InteractionAcknowledgement,
  command: InteractionResponseCommand,
): void {
  const actual = acknowledgement.binding;
  const expected = command.binding;
  if (
    acknowledgement.operationId !== command.operationId ||
    acknowledgement.commandDigest !== command.commandDigest ||
    actual.runId !== expected.runId ||
    actual.provider !== expected.provider ||
    actual.environmentId !== expected.environmentId ||
    actual.sessionId !== expected.sessionId ||
    actual.executionId !== expected.executionId ||
    actual.interactionId !== expected.interactionId ||
    actual.requestDigest !== expected.requestDigest
  ) {
    throw new Error(
      "cli-bridge returned an interaction acknowledgement for another operation",
    );
  }
}

/** Send one retry-safe response command to its exact retained CLI run. */
export function cliBridgeInteractionResponder(
  options: CliBridgeInteractionResponderOptions,
): (
  command: InteractionResponseCommand,
  operation?: { signal?: AbortSignal },
) => Promise<InteractionAcknowledgement> {
  return async (command, operation) => {
    const exact = InteractionResponseCommandSchema.parse(command);
    operation?.signal?.throwIfAborted();
    if (
      exact.binding.provider !== options.providerName ||
      exact.binding.environmentId !== options.environmentId ||
      (options.sessionId !== undefined && exact.binding.sessionId !== options.sessionId)
    ) {
      return InteractionAcknowledgementSchema.parse({
        operationId: exact.operationId,
        binding: exact.binding,
        commandDigest: exact.commandDigest,
        status: "binding_mismatch",
        message:
          "interaction response does not use this cli-bridge environment binding",
      });
    }

    let response: Awaited<ReturnType<CliBridgeTransport["fetch"]>>;
    try {
      response = await options.transport.fetch(
        `${trimSlash(options.options.baseUrl)}/v1/runs/${encodeURIComponent(
          exact.binding.runId,
        )}/interactions/${encodeURIComponent(
          exact.binding.interactionId,
        )}/respond`,
        {
          method: "POST",
          headers: requestHeaders(options.options),
          body: JSON.stringify(exact),
          ...(operation?.signal ? { signal: operation.signal } : {}),
        },
      );
    } catch (error) {
      operation?.signal?.throwIfAborted();
      return transportFailure(exact, error);
    }
    operation?.signal?.throwIfAborted();

    let acknowledgement: InteractionAcknowledgement;
    const retryableOnMalformed =
      response.status >= 500 || (response.status >= 200 && response.status < 300);
    try {
      acknowledgement = InteractionAcknowledgementSchema.parse(
        JSON.parse(await readBoundedCliBridgeResponse(
          response,
          MAX_CLI_BRIDGE_CONTROL_RESPONSE_BYTES,
          operation?.signal,
        )),
      );
    } catch (error) {
      return transportFailure(exact, error, retryableOnMalformed);
    }
    assertAcknowledgesCommand(acknowledgement, exact);
    return classifyAcknowledgement(acknowledgement, response.status);
  };
}

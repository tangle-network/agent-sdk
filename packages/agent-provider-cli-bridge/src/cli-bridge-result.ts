import {
  parseJson,
  readBoundedUtf8Body,
  safeJson,
  usageFromOpenAi,
} from "./cli-bridge-sse.js";
import {
  assertLimit,
  boundedErrorDetail,
  CLI_BRIDGE_MAX_EVENTS,
  CLI_BRIDGE_MAX_RESULT_TEXT_BYTES,
  CLI_BRIDGE_MAX_TOOL_CALLS,
  CliBridgeProtocolError,
  preserveRootError,
  utf8Bytes,
} from "./cli-bridge-limits.js";
import {
  acceptCliBridgeResponse,
  detachCliBridgeReader,
  readCliBridgeResponseText,
} from "./cli-bridge-response.js";
import { requestHeaders, trimSlash } from "./cli-bridge-transport.js";
import type { TokenUsage } from "@tangle-network/agent-interface";
import type {
  CliBridgeProviderOptions,
  CliBridgeResponse,
  CliBridgeTransport,
} from "./cli-bridge-types.js";

export async function readFullCliBridgeResult(
  options: CliBridgeProviderOptions,
  requestBody: string,
  transport: CliBridgeTransport,
  signal?: AbortSignal,
  sessionId?: string,
  onAccepted?: (response: CliBridgeResponse) => void,
): Promise<{
  text: string;
  finishReason: string;
  usage?: TokenUsage;
}> {
  const body = safeJson(requestBody);
  if (!body) throw new Error("cli-bridge replay request is not valid JSON");
  const response = await transport.fetch(
    `${trimSlash(options.baseUrl)}/v1/chat/completions`,
    {
      method: "POST",
      headers: requestHeaders(options, sessionId),
      body: JSON.stringify({ ...body, stream: false }),
      signal,
    },
  );
  if (!response.ok) {
    throw new Error(
      `cli-bridge replay result ${response.status}: ${boundedErrorDetail(
        await readCliBridgeResponseText(response),
      )}`,
    );
  }
  let bodyConsumed = false;
  let rootError: unknown;
  try {
    acceptCliBridgeResponse(response, requestBody, onAccepted);
    if (!response.body) throw new CliBridgeProtocolError("invalid-body", 0, 0);
    const responseBody = response.body;
    const parsed = parseJson(await readBoundedUtf8Body(responseBody));
    bodyConsumed = true;
    if (parsed.error && typeof parsed.error === "object") {
      const error = parsed.error as Record<string, unknown>;
      const message =
        typeof error.message === "string"
          ? boundedErrorDetail(error.message)
          : "cli-bridge replay failed";
      throw new Error(`cli-bridge replay result failed: ${message}`);
    }
    const choices = Array.isArray(parsed.choices) ? parsed.choices : undefined;
    if (choices) {
      assertLimit(choices.length, CLI_BRIDGE_MAX_EVENTS, "event-count");
    }
    const choice = choices?.[0];
    const message =
      choice?.message && typeof choice.message === "object"
        ? (choice.message as Record<string, unknown>)
        : undefined;
    if (
      typeof message?.content !== "string" ||
      typeof choice?.finish_reason !== "string"
    ) {
      throw new CliBridgeProtocolError("invalid-json", 0, 0);
    }
    if (Array.isArray(message.tool_calls)) {
      assertLimit(
        message.tool_calls.length,
        CLI_BRIDGE_MAX_TOOL_CALLS,
        "tool-call-count",
      );
    }
    if (choice.finish_reason === "error" || choice.finish_reason === "timeout") {
      throw new Error(
        `cli-bridge replay result ended ${choice.finish_reason}`,
      );
    }
    const textBytes = utf8Bytes(message.content);
    if (textBytes > CLI_BRIDGE_MAX_RESULT_TEXT_BYTES) {
      throw new CliBridgeProtocolError(
        "result-text-bytes",
        CLI_BRIDGE_MAX_RESULT_TEXT_BYTES,
        textBytes,
      );
    }
    const usage = usageFromOpenAi(parsed.usage);
    return {
      text: message.content,
      finishReason: choice.finish_reason,
      ...(usage ? { usage } : {}),
    };
  } catch (error) {
    rootError = error;
    throw error;
  } finally {
    if (!bodyConsumed && response.body) {
      try {
        await detachCliBridgeReader(response.body);
      } catch (detachError) {
        if (rootError !== undefined) {
          throw preserveRootError(
            rootError,
            detachError,
            "cli-bridge replay reader cleanup failed",
          );
        }
        throw detachError;
      }
    }
  }
}

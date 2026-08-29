import {
  ContextTransferRequestSchema,
  ContextTransferResultSchema,
  contextTransferResultMatchesRequest,
  type AgentContextTransferProvider,
  type ContextTransferRequest,
  type ContextTransferResult,
  type ContextTransferReceipt,
} from "@tangle-network/agent-interface";
import type { CliBridgeProviderOptions } from "./provider-options.js";
import {
  createCliBridgeTransport,
  MAX_CLI_BRIDGE_CONTROL_RESPONSE_BYTES,
  readBoundedCliBridgeResponse,
  requestHeaders,
  trimSlash,
} from "./transport.js";

/** Bind the shared portable-context contract to CLI Bridge's durable endpoint. */
export function createCliBridgeContextTransfer(
  options: CliBridgeProviderOptions,
): AgentContextTransferProvider {
  return {
    transfer: (request, transferOptions) =>
      transferCliBridgeContext(options, request, transferOptions?.signal),
    lookup: (request, lookupOptions) =>
      lookupCliBridgeContext(options, request, lookupOptions?.signal),
  };
}

export async function transferCliBridgeContext(
  options: CliBridgeProviderOptions,
  request: ContextTransferRequest,
  signal?: AbortSignal,
): Promise<ContextTransferResult> {
  const exact = ContextTransferRequestSchema.parse(request);
  const transport = createCliBridgeTransport(options);
  try {
    const response = await transport.fetch(
      `${trimSlash(options.baseUrl)}/v1/context-transfers`,
      {
        method: "POST",
        headers: requestHeaders(options),
        body: JSON.stringify(exact),
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const body = await readBoundedCliBridgeResponse(
      response,
      MAX_CLI_BRIDGE_CONTROL_RESPONSE_BYTES,
      signal,
    );
    return parseContextTransferResponse(exact, response.status, body);
  } catch (error) {
    signal?.throwIfAborted();
    return transportFailure(exact, error);
  } finally {
    await transport.close();
  }
}

export async function lookupCliBridgeContext(
  options: CliBridgeProviderOptions,
  request: ContextTransferRequest,
  signal?: AbortSignal,
): Promise<ContextTransferResult | undefined> {
  const exact = ContextTransferRequestSchema.parse(request);
  const transport = createCliBridgeTransport(options);
  try {
    const response = await transport.fetch(
      `${trimSlash(options.baseUrl)}/v1/context-transfers/${encodeURIComponent(exact.operationId)}?request_digest=${encodeURIComponent(exact.requestDigest)}`,
      {
        method: "GET",
        headers: requestHeaders(options),
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const body = await readBoundedCliBridgeResponse(
      response,
      MAX_CLI_BRIDGE_CONTROL_RESPONSE_BYTES,
      signal,
    );
    if (response.status === 404) return undefined;
    return parseContextTransferResponse(exact, response.status, body);
  } catch (error) {
    signal?.throwIfAborted();
    return transportFailure(exact, error);
  } finally {
    await transport.close();
  }
}

/** Recover the accepted destination route for one caller-owned environment id. */
export async function lookupCliBridgeContextByEnvironment(
  options: CliBridgeProviderOptions,
  environmentId: string,
  signal?: AbortSignal,
): Promise<ContextTransferReceipt | undefined> {
  const transport = createCliBridgeTransport(options);
  try {
    const response = await transport.fetch(
      `${trimSlash(options.baseUrl)}/v1/context-transfer-environments/${encodeURIComponent(environmentId)}`,
      {
        method: "GET",
        headers: requestHeaders(options),
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const body = await readBoundedCliBridgeResponse(
      response,
      MAX_CLI_BRIDGE_CONTROL_RESPONSE_BYTES,
      signal,
    );
    if (response.status === 404) return undefined;
    const parsed = parseContextTransferResult(body, response.status);
    if (
      (parsed.status !== "accepted" && parsed.status !== "replayed") ||
      parsed.environmentId !== environmentId
    ) {
      throw new Error("CLI Bridge returned a context transfer for another environment");
    }
    return parsed;
  } finally {
    await transport.close();
  }
}

function parseContextTransferResponse(
  request: ContextTransferRequest,
  status: number,
  body: string,
): ContextTransferResult {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    return transportFailure(
      request,
      new Error(`CLI Bridge context transfer returned HTTP ${status} with invalid JSON`, {
        cause: error,
      }),
    );
  }
  const parsed = ContextTransferResultSchema.safeParse(value);
  if (!parsed.success || !contextTransferResultMatchesRequest(request, parsed.data)) {
    return transportFailure(
      request,
      new Error(`CLI Bridge context transfer returned HTTP ${status} with an invalid result`),
    );
  }
  return parsed.data;
}

function parseContextTransferResult(body: string, status: number): ContextTransferResult {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new Error(`CLI Bridge context transfer returned HTTP ${status} with invalid JSON`, {
      cause: error,
    });
  }
  const parsed = ContextTransferResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`CLI Bridge context transfer returned HTTP ${status} with an invalid result`);
  }
  return parsed.data;
}

function transportFailure(
  request: ContextTransferRequest,
  error: unknown,
): ContextTransferResult {
  const message = error instanceof Error ? error.message : String(error);
  return ContextTransferResultSchema.parse({
    status: "transport_failure",
    operationId: request.operationId,
    requestDigest: request.requestDigest,
    message: message.slice(0, 4_096) || "CLI Bridge context transfer failed",
    retryable: true,
  });
}

import { Agent, fetch as undiciFetch } from "undici";
import type { CliBridgeProviderOptions } from "./provider-options.js";

export const MAX_CLI_BRIDGE_CONTROL_RESPONSE_BYTES = 64 * 1024;
export const MAX_CLI_BRIDGE_RESULT_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface CliBridgeTransport {
  fetch(input: string, init: CliBridgeRequest): Promise<CliBridgeResponse>;
  close(): Promise<void>;
}

export interface CliBridgeRequest {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface CliBridgeResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: AsyncIterable<Uint8Array> | null;
  readonly headers: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
}

export function createCliBridgeTransport(
  options: CliBridgeProviderOptions,
): CliBridgeTransport {
  if (options.fetch) {
    const fetch = options.fetch;
    return {
      fetch: (input, init) => fetch(input, init),
      close: async () => {},
    };
  }
  const dispatcher = new Agent({
    headersTimeout: options.headersTimeoutMs ?? 0,
    bodyTimeout: options.bodyTimeoutMs ?? 0,
  });
  return {
    fetch: (input, init) =>
      undiciFetch(input, {
        ...init,
        dispatcher,
      }),
    close: async () => {
      await dispatcher.close();
    },
  };
}

export function requestHeaders(options: CliBridgeProviderOptions): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(options.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {}),
  };
}

export function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export async function readBoundedCliBridgeResponse(
  response: CliBridgeResponse,
  maxBytes: number,
): Promise<string> {
  if (response.body === null) return "";
  const iterator = response.body[Symbol.asyncIterator]();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        throw new Error(`cli-bridge response exceeded ${maxBytes} bytes`);
      }
      chunks.push(decoder.decode(next.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    await iterator.return?.();
  }
}

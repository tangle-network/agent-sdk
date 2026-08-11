import { Agent, fetch as undiciFetch } from "undici";
import type { CliBridgeProviderOptions } from "./provider-options.js";

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

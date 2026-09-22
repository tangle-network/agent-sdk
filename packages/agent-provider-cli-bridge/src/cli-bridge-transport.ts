import { Agent, fetch as undiciFetch } from "undici";
import type {
  CliBridgeProviderOptions,
  CliBridgeRequest,
  CliBridgeTransport,
} from "./cli-bridge-types.js";

export function createTransport(
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

export function requestHeaders(
  options: CliBridgeProviderOptions,
  sessionId?: string,
): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(options.bearerToken
      ? { authorization: `Bearer ${options.bearerToken}` }
      : {}),
    ...(sessionId ? { "x-session-id": sessionId } : {}),
  };
}

export function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

import { parseCredentialCapacity, type TangleCredentialCapacityError } from "./model-credential-capacity.js";
import type { CreateAgentEnvironmentInput } from "@tangle-network/agent-interface/environment-provider";
import { profileCredentialSource } from "./model-credential-source.js";
import { parseModelCredentialResolverRequest } from "./model-credential-request.js";
import { captureModelCredentials } from "./tangle-create-options.js";
import type { TangleModelCredentialResolver } from "./tangle-types.js";

export interface HttpModelCredentialResolverOptions {
  /** HTTPS broker endpoint, or HTTP on loopback for private local transport. */
  url: string;
  /** Narrow resolve-only grant. Never use a Bridge launch bearer here. */
  bearer: string;
  timeoutMs?: number;
  minimumValidUntil?: string;
  minimumValidityMs?: number;
}

const MAX_PUBLIC_RESPONSE_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

async function publicResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Tangle credential broker returned an empty public response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_PUBLIC_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Tangle credential broker exceeded its public-output bound");
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error("Tangle credential broker returned an invalid public reference");
    }
  } finally {
    reader.releaseLock();
  }
}

/** Send exact profile intent to the trusted account owner, without exporting owner credentials. */
export function createHttpModelCredentialResolver(options: HttpModelCredentialResolverOptions): TangleModelCredentialResolver {
  let endpoint: URL;
  try { endpoint = new URL(options.url); } catch { throw new Error("Tangle credential broker URL is invalid"); }
  if (typeof options.url !== "string" || options.url.length > 2048 || /\s/.test(options.url) ||
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && LOOPBACK.has(endpoint.hostname)))) {
    throw new Error("Tangle credential broker requires HTTPS or loopback HTTP without URL credentials");
  }
  if (typeof options.bearer !== "string" || options.bearer.length < 32 || options.bearer.length > 4096 || /\s/.test(options.bearer)) {
    throw new Error("Tangle credential broker requires a bounded narrow bearer grant");
  }
  const bearer = options.bearer;
  const url = endpoint.href;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error("Tangle credential broker timeoutMs must be a positive timer bound");
  }
  if (options.minimumValidUntil !== undefined && options.minimumValidityMs !== undefined) {
    throw new Error("Tangle credential broker accepts one validity deadline");
  }
  if (options.minimumValidityMs !== undefined && (!Number.isSafeInteger(options.minimumValidityMs) || options.minimumValidityMs <= 0)) {
    throw new Error("Tangle credential broker minimumValidityMs must be a positive integer");
  }
  const deadline = options.minimumValidUntil === undefined
    ? options.minimumValidityMs === undefined ? undefined : new Date(Date.now() + options.minimumValidityMs)
    : typeof options.minimumValidUntil === "string" && options.minimumValidUntil.length <= 128
      ? new Date(options.minimumValidUntil) : new Date(NaN);
  if (deadline !== undefined && !Number.isFinite(deadline.getTime())) {
    throw new Error("Tangle credential broker validity deadline must be a valid timestamp");
  }
  const minimumValidUntil = deadline?.toISOString();
  return async (input: Readonly<CreateAgentEnvironmentInput>) => {
    if (typeof input.profile === "string") throw new Error("Tangle credential broker requires an inline profile");
    if (profileCredentialSource(input.profile) === "managed") return undefined;
    input.signal?.throwIfAborted();
    const { signal, ...data } = input;
    const request = parseModelCredentialResolverRequest({ input: data, ...(minimumValidUntil === undefined ? {} : { minimumValidUntil }) });
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new Error("Tangle credential broker request exceeds the profile limit");
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
          body, redirect: "error", credentials: "omit", signal: controller.signal,
        });
      } catch {
        throw new Error(controller.signal.aborted ? "Tangle credential broker request aborted or timed out" : "Tangle credential broker request failed");
      }
      if (!response.ok) {
        let exitCode: number | undefined;
        let capacity: TangleCredentialCapacityError | undefined;
        try {
          const payload = await publicResponse(response);
          capacity = parseCredentialCapacity(payload, response.status);
          const detail = payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
          if (detail && typeof detail === "object" && "exitCode" in detail &&
            typeof detail.exitCode === "number" && Number.isSafeInteger(detail.exitCode) && detail.exitCode >= 0 && detail.exitCode <= 255) {
            exitCode = detail.exitCode;
          }
        } catch {
          // Upstream bodies and diagnostics are private; only a bounded numeric exit status is public.
        }
        if (capacity !== undefined) throw capacity;
        throw Object.assign(new Error(`Tangle credential broker refused resolution (HTTP ${response.status}${exitCode === undefined ? "" : `, owner exit ${exitCode}`})`), {
          status: response.status, ...(exitCode === undefined ? {} : { exitCode }),
        });
      }
      try {
        const selected = captureModelCredentials(await publicResponse(response) as Parameters<typeof captureModelCredentials>[0]);
        if (selected === undefined) throw new Error();
        return selected;
      } catch {
        throw new Error("Tangle credential broker returned an invalid public reference");
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

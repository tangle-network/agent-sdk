import type { SeatOwnerReply } from "@tangle-network/sandbox";
import { credentialDeadline, ownerCredentialResolver, type CredentialValidityOptions } from "./model-credential-resolver.js";
import type { ModelCredentialResolverRequest } from "./model-credential-request.js";
import type { TangleModelCredentialResolver } from "./tangle-types.js";

export interface HttpModelCredentialResolverOptions extends CredentialValidityOptions {
  /** HTTPS owner endpoint, or HTTP on loopback for a private local transport. */
  url: string;
  /** Separate read-only owner route validation endpoint; never resolves credentials. */
  validationUrl?: string;
  bearer: string;
  timeoutMs?: number;
}

const MAX_PUBLIC_RESPONSE_BYTES = 64 * 1024;

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

/** The owner broker keeps private account credentials behind its narrow resolve-only grant. */
export function createHttpModelCredentialResolver(options: HttpModelCredentialResolverOptions): TangleModelCredentialResolver {
  if (typeof options.bearer !== "string" || options.bearer.length < 32 || options.bearer.length > 4096 || /\s/.test(options.bearer))
    throw new Error("Tangle credential broker requires a bounded narrow bearer grant");
  const bearer = options.bearer;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw new Error("Tangle credential broker timeoutMs must be a positive timer bound");
  const transport = (url: string) => {
    let endpoint: URL;
    try { endpoint = new URL(url); } catch { throw new Error("Tangle credential broker URL is invalid"); }
    if (typeof url !== "string" || url.length > 2048 || /\s/.test(url) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))))
      throw new Error("Tangle credential broker requires HTTPS or loopback HTTP without URL credentials");
    return async (request: ModelCredentialResolverRequest, signal?: AbortSignal): Promise<SeatOwnerReply> => {
      const body = JSON.stringify(request);
      if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error("Tangle credential broker request exceeds the profile limit");
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort",abort,{once:true});
      if (signal?.aborted) abort();
      const timer = setTimeout(abort,timeoutMs);
      try {
        const response = await fetch(endpoint.href,{body,method:"POST",headers:{Authorization:`Bearer ${bearer}`,"Content-Type":"application/json"},redirect:"error",credentials:"omit",signal:controller.signal});
        return {ok:response.ok,status:response.status,body:await publicResponse(response)};
      } finally { clearTimeout(timer);signal?.removeEventListener("abort",abort); }
    };
  };
  return ownerCredentialResolver(transport(options.url), credentialDeadline(options), "broker",
    options.validationUrl === undefined ? undefined : transport(options.validationUrl));
}

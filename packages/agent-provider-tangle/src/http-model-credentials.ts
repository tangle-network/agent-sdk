import { gatewaySeatTransport } from "@tangle-network/sandbox";
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

/** The SDK owns bounded JSON transport; the broker grant stays private to this adapter. */
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
    return gatewaySeatTransport<ModelCredentialResolverRequest>({
      fetch: async (_path, init) => {
        const body = typeof init?.body === "string" ? init.body : "";
        if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error("Tangle credential broker request exceeds the profile limit");
        const signal = init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
        try { return await fetch(endpoint.href, { ...init, body, method:"POST", headers:{Authorization:`Bearer ${bearer}`,"Content-Type":"application/json"},redirect:"error",credentials:"omit",signal }); }
        catch { throw new Error(signal.aborted ? "Tangle credential broker request aborted or timed out" : "Tangle credential broker request failed"); }
      },
    });
  };
  return ownerCredentialResolver(transport(options.url), credentialDeadline(options), "broker",
    options.validationUrl === undefined ? undefined : transport(options.validationUrl));
}

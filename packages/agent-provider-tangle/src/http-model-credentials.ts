import { gatewaySeatTransport } from "@tangle-network/sandbox";
import { credentialDeadline, ownerCredentialResolver, type CredentialValidityOptions } from "./model-credential-resolver.js";
import type { ModelCredentialResolverRequest } from "./model-credential-request.js";
import type { TangleModelCredentialResolver } from "./tangle-types.js";

export interface HttpModelCredentialResolverOptions extends CredentialValidityOptions {
  /** HTTPS owner endpoint, or HTTP on loopback for a private local transport. */
  url: string;
  /** Separate read-only owner route validation endpoint; never resolves credentials. */
  validationUrl?: string;
  bearer: string | (() => string);
  timeoutMs?: number;
}

/** The owner broker keeps private account credentials behind its narrow resolve-only grant. */
export function createHttpModelCredentialResolver(options: HttpModelCredentialResolverOptions): TangleModelCredentialResolver {
  const transport = (url: string) => gatewaySeatTransport<ModelCredentialResolverRequest>({
    url, bearer: options.bearer, timeoutMs: options.timeoutMs,
  });
  return ownerCredentialResolver(transport(options.url), credentialDeadline(options), "broker",
    options.validationUrl === undefined ? undefined : transport(options.validationUrl));
}

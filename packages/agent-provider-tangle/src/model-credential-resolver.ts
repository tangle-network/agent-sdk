import type { SeatOwnerReply, SeatOwnerTransport } from "@tangle-network/sandbox";
import type { CreateAgentEnvironmentInput } from "@tangle-network/agent-interface/environment-provider";
import { parseCredentialCapacity, parseCredentialRefusal, TangleCredentialCommandError } from "./model-credential-capacity.js";
import { profileCredentialSource } from "./model-credential-source.js";
import { parseModelCredentialResolverRequest, type ModelCredentialResolverRequest } from "./model-credential-request.js";
import { captureModelCredentials } from "./tangle-create-options.js";
import type { TangleModelCredentialResolver } from "./tangle-types.js";

export interface CredentialValidityOptions {
  minimumValidUntil?: string;
  minimumValidityMs?: number;
}

export function credentialDeadline(options: CredentialValidityOptions): string | undefined {
  if (options.minimumValidUntil !== undefined && options.minimumValidityMs !== undefined)
    throw new Error("Tangle credential resolver accepts one validity deadline");
  if (options.minimumValidityMs !== undefined && (!Number.isSafeInteger(options.minimumValidityMs) || options.minimumValidityMs <= 0))
    throw new Error("Tangle credential resolver minimumValidityMs must be a positive integer");
  const deadline = options.minimumValidUntil === undefined
    ? options.minimumValidityMs === undefined ? undefined : new Date(Date.now() + options.minimumValidityMs)
    : typeof options.minimumValidUntil === "string" && options.minimumValidUntil.length <= 128 ? new Date(options.minimumValidUntil) : new Date(NaN);
  if (deadline !== undefined && !Number.isFinite(deadline.getTime()))
    throw new Error("Tangle credential resolver validity deadline must be a valid timestamp");
  return deadline?.toISOString();
}

export function ownerCredentialResolver(
  transport: SeatOwnerTransport<ModelCredentialResolverRequest>,
  minimumValidUntil: string | undefined,
  kind: "command" | "broker",
  validation?: SeatOwnerTransport<ModelCredentialResolverRequest>,
): TangleModelCredentialResolver {
  const request = (input: Readonly<CreateAgentEnvironmentInput>) => {
    const { signal: _, ...data } = input;
    return parseModelCredentialResolverRequest({ input: data, ...(minimumValidUntil === undefined ? {} : { minimumValidUntil }) });
  };
  const rejectReply = (reply: SeatOwnerReply): never => {
    const status = kind === "broker" ? reply.status : undefined;
    const typed = ([429,503].includes(reply.status) ? parseCredentialCapacity(reply.body, status) : undefined) ??
      (reply.status === 400 ? parseCredentialRefusal(reply.body, status) : undefined);
    if (typed) throw typed;
    if (kind === "command") throw new TangleCredentialCommandError(reply.status === 200 ? 0 : reply.status === 400 ? 78 : reply.status === 503 ? 75 : null, null);
    const detail = reply.body && typeof reply.body === "object" && "error" in reply.body ? reply.body.error : undefined;
    const exitCode = detail && typeof detail === "object" && "exitCode" in detail ? detail.exitCode : undefined;
    throw Object.assign(new Error(`Tangle credential broker refused resolution (HTTP ${reply.status})`), {
      status:reply.status, ...(typeof exitCode === "number" && Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? {exitCode} : {}),
    });
  };
  const resolver: TangleModelCredentialResolver = (input) => {
    if (typeof input.profile === "string") throw new Error(`Tangle credential ${kind} requires an inline profile`);
    if (profileCredentialSource(input.profile) === "router") return undefined;
    input.signal?.throwIfAborted();
    const body = request(input);
    return transport(body, input.signal).catch(error => {
      if (kind === "command") throw error;
      throw new Error(input.signal?.aborted ? "Tangle credential broker request aborted" : "Tangle credential broker request failed or returned an invalid public reference");
    }).then(reply => {
      if (!reply.ok) rejectReply(reply);
      try {
        const selected = captureModelCredentials(reply.body as Parameters<typeof captureModelCredentials>[0]);
        if (selected === undefined) throw new Error();
        return selected;
      } catch {
        throw kind === "command" ? new TangleCredentialCommandError(0, null)
          : new Error("Tangle credential broker returned an invalid public reference");
      }
    });
  };
  if (validation) {
    resolver.validate = async (profile) => {
      if (typeof profile === "string") return { ok: false, issues: [{level:"error",code:"PROFILE_UNSUPPORTED",message:"Subscription route validation requires an inline profile"}] };
      if (profileCredentialSource(profile) === "router") return { ok: true, issues: [] };
      const reply = await validation(request({ profile, idempotencyKey: "profile-preflight" }));
      const body = reply.body as { supported?: unknown; error?: unknown } | null;
      if (reply.ok && body?.supported === true && Object.keys(body).length === 1) return { ok: true, issues: [] };
      const refusal = reply.status === 400 && body?.supported === false && Object.keys(body).every(k => k === "supported" || k === "error")
        ? parseCredentialRefusal({error:body.error}, kind === "broker" ? reply.status : undefined) : undefined;
      if (!refusal) rejectReply(reply);
      return { ok: false, issues: [{level:"error",code:refusal.code,message:refusal.message}] };
    };
  }
  return resolver;
}

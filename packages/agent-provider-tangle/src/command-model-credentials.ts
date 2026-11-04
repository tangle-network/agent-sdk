import { commandSeatTransport } from "@tangle-network/sandbox/select-seat/command";
import { TangleCredentialCommandError } from "./model-credential-capacity.js";
import { credentialDeadline, ownerCredentialResolver, type CredentialValidityOptions } from "./model-credential-resolver.js";
import type { ModelCredentialResolverRequest } from "./model-credential-request.js";
import type { TangleModelCredentialResolver } from "./tangle-types.js";

export interface CommandModelCredentialResolverOptions extends CredentialValidityOptions {
  /** Executable and arguments, invoked directly without a shell. */
  command: readonly string[];
  /** Owner's read-only route validator, e.g. acct's configured --validate-only argv. */
  validationCommand?: readonly string[];
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

/** The SDK owns process transport; this adapter owns custody references and owner refusal types. */
export function createCommandModelCredentialResolver(options: CommandModelCredentialResolverOptions): TangleModelCredentialResolver {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw new Error("Tangle credential command timeoutMs must be a positive timer bound");
  if (options.env !== undefined && (!options.env || typeof options.env !== "object" || Array.isArray(options.env) ||
    Object.entries(options.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0"))))
    throw new Error("Tangle credential command env must contain valid private process variables");
  const transport = (command: readonly string[]) => {
    if (!Array.isArray(command) || !command.length || command.length > 128 || command.some(p => typeof p !== "string" || !p || p.length > 4096 || p.includes("\0")))
      throw new Error("Tangle credential command must contain an executable and bounded arguments");
    const send = commandSeatTransport<ModelCredentialResolverRequest>({ command: [...command], env: { ...process.env, ...options.env }, timeoutMs });
    return async (request: ModelCredentialResolverRequest, signal?: AbortSignal) => {
      try { return await send(request, signal); }
      catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        const detail = error as { exitCode?: number | null; terminationSignal?: NodeJS.Signals | null };
        throw new TangleCredentialCommandError(detail.exitCode ?? null, detail.terminationSignal ?? null);
      }
    };
  };
  return ownerCredentialResolver(transport(options.command), credentialDeadline(options), "command",
    options.validationCommand === undefined ? undefined : transport(options.validationCommand));
}

import { commandSeatTransport, SeatOwnerCommandError } from "@tangle-network/sandbox/select-seat/command";
import { TangleCredentialCommandError } from "./model-credential-capacity.js";
import { credentialDeadline, ownerCredentialResolver, type CredentialValidityOptions } from "./model-credential-resolver.js";
import type { ModelCredentialResolverRequest } from "./model-credential-request.js";
import type { TangleModelCredentialResolver } from "./tangle-types.js";

export interface CommandModelCredentialResolverOptions extends CredentialValidityOptions {
  command: readonly string[];
  /** Owner's read-only validator, e.g. the configured acct --validate-only command. */
  validationCommand?: readonly string[];
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

export function createCommandModelCredentialResolver(options: CommandModelCredentialResolverOptions): TangleModelCredentialResolver {
  const transport = (command: readonly string[]) => {
    const owner = commandSeatTransport<ModelCredentialResolverRequest>({
      command, timeoutMs: options.timeoutMs, env: () => ({ ...process.env, ...options.env }),
    });
    return async (request: ModelCredentialResolverRequest, signal?: AbortSignal) => {
      try { return await owner(request, signal); }
      catch (error) {
        signal?.throwIfAborted();
        if (error instanceof SeatOwnerCommandError)
          throw new TangleCredentialCommandError(error.exitCode, error.terminationSignal);
        throw error;
      }
    };
  };
  return ownerCredentialResolver(transport(options.command), credentialDeadline(options), "command",
    options.validationCommand === undefined ? undefined : transport(options.validationCommand));
}

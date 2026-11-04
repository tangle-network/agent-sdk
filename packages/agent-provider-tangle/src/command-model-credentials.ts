import { spawn } from "node:child_process";
import type { SeatOwnerReply } from "@tangle-network/sandbox";
import type { AgentTurnFailure } from "@tangle-network/agent-interface";
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

/** Legacy owners report these permanent refusals only on stderr; retain until typed78 is served. */
export class TangleCommandCredentialRefusalError extends Error {
  readonly code = "model_credential_refused" as const;
  readonly failure: AgentTurnFailure = {kind:"caller",code:this.code};
  constructor(readonly resolutionReason: string) {
    super(`Tangle credential command refused the route: ${resolutionReason}`);
    this.name = "TangleCredentialRefusalError";
  }
}
const RESOLUTION_REFUSAL = /(?:resume seat conflicts|already bound to a different (?:dispatch|profile)|not enrolled for the exact stage profile)/iu;

export function createCommandModelCredentialResolver(options: CommandModelCredentialResolverOptions): TangleModelCredentialResolver {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw new Error("Tangle credential command timeoutMs must be a positive timer bound");
  if (options.env !== undefined && (!options.env || typeof options.env !== "object" || Array.isArray(options.env) ||
    Object.entries(options.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0"))))
    throw new Error("Tangle credential command env must contain valid private process variables");
  const environment = { ...process.env, ...options.env };
  const transport = (argv: readonly string[]) => {
    if (!Array.isArray(argv) || !argv.length || argv.length > 128 || argv.some(p => typeof p !== "string" || !p || p.length > 4096 || p.includes("\0")))
      throw new Error("Tangle credential command must contain an executable and bounded arguments");
    const command = Object.freeze([...argv]);
    return (request: ModelCredentialResolverRequest, signal?: AbortSignal) => new Promise<SeatOwnerReply>((resolve,reject) => {
      signal?.throwIfAborted();
      const child = spawn(command[0]!,command.slice(1),{env:environment,shell:false,stdio:["pipe","pipe","pipe"]});
      let settled = false, bytes = 0, stderr = "";
      const chunks: Buffer[] = [];
      const cleanup = () => { clearTimeout(timer);signal?.removeEventListener("abort",abort); };
      const fail = (error: unknown) => { if (settled) return;settled=true;cleanup();child.kill("SIGKILL");reject(error); };
      const abort = () => fail(signal?.reason ?? new Error("Tangle credential command aborted"));
      const timer = setTimeout(() => fail(new TangleCredentialCommandError(null,null)),timeoutMs);
      signal?.addEventListener("abort",abort,{once:true});
      child.on("error",() => fail(new TangleCredentialCommandError(null,null)));
      child.stdin.on("error",() => fail(new TangleCredentialCommandError(null,null)));
      child.stdout.on("data",(chunk: Buffer) => { bytes += chunk.length;if(bytes>64*1024) fail(new TangleCredentialCommandError(null,null));else chunks.push(chunk); });
      child.stderr.on("data",(chunk: Buffer) => { stderr=(stderr+chunk.toString("utf8")).slice(-8*1024); });
      child.on("close",(code,terminationSignal) => {
        if (settled) return;
        if (code !== 0 && code !== 75 && code !== 78) {
          const reason = stderr.split("\n").map(v=>v.trimEnd()).filter(v=>v.trim()&&!/^Node\.js v\d/u.test(v.trim())&&!/^\s+at\s/u.test(v)).at(-1)?.slice(0,300);
          fail(reason && RESOLUTION_REFUSAL.test(reason) ? new TangleCommandCredentialRefusalError(reason) : new TangleCredentialCommandError(code,terminationSignal));
          return;
        }
        let body: unknown;
        try { body=JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { fail(new TangleCredentialCommandError(code,null));return; }
        settled=true;cleanup();resolve({ok:code===0,status:code===0?200:code===75?503:400,body});
      });
      if (signal?.aborted) abort();
      else child.stdin.end(JSON.stringify(request)+"\n");
    });
  };
  return ownerCredentialResolver(transport(options.command),credentialDeadline(options),"command",
    options.validationCommand === undefined ? undefined : transport(options.validationCommand));
}

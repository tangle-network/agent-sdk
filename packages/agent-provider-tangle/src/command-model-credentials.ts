import { parseCredentialCapacity, parseCredentialRefusal } from "./model-credential-capacity.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { CreateAgentEnvironmentInput } from "@tangle-network/agent-interface/environment-provider";
import { profileCredentialSource } from "./model-credential-source.js";
import { captureModelCredentials } from "./tangle-create-options.js";
import type { TangleModelCredentialResolver, TangleModelCredentials } from "./tangle-types.js";

export interface CommandModelCredentialResolverOptions {
  /** Executable and arguments, invoked directly without a shell. */
  command: readonly string[];
  /** Additional private process environment; never included in public receipts. */
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  /** Fixed absolute run deadline, retained across controller recovery. */
  minimumValidUntil?: string;
  /** Compute a fixed deadline once at factory construction. */
  minimumValidityMs?: number;
}

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
/** How much of the command's stderr is retained, and how much of its last line can surface. */
const MAX_COMMAND_STDERR_BYTES = 8 * 1024;
const MAX_STDERR_TAIL_CHARACTERS = 300;

/**
 * The resolver refused the binding itself — a deterministic refusal named on the error
 * (bounded, from the command's last stderr line). Carries the same machine code as every
 * credential route refusal, so a consumer classifies it terminal instead of retrying a
 * refusal no retry can satisfy (#475).
 */
export class TangleCommandCredentialRefusalError extends Error {
  readonly code = "model_credential_refused" as const;
  /** The resolver's own bounded reason, safe to journal. */
  readonly resolutionReason: string;

  constructor(reason: string) {
    super(`Tangle credential command refused the route: ${reason}`);
    this.name = "TangleCredentialRefusalError";
    this.resolutionReason = reason;
  }
}

/**
 * Resolver refusals a retry cannot satisfy, from `acct sandbox resolve`'s ResolutionError lines.
 * The list is deliberately narrow: anything unmatched stays the generic failure with its
 * `stderrTail`, and the resolver can later grow an exit-code contract beside exit 75's capacity.
 */
const RESOLUTION_REFUSAL = /(?:resume seat conflicts|already bound to a different (?:dispatch|profile)|not enrolled for the exact stage profile)/iu;

/** The account owner selects, binds, refreshes, and stores credentials; this transport reads references. */
export function createCommandModelCredentialResolver(
  options: CommandModelCredentialResolverOptions,
): TangleModelCredentialResolver {
  if (!Array.isArray(options.command) || options.command.length === 0 || options.command.length > 128 ||
    options.command.some((part) => typeof part !== "string" || part.length === 0 || part.length > 4096 || part.includes("\0"))) {
    throw new Error("Tangle credential command must contain an executable and bounded arguments");
  }
  const command = Object.freeze([...options.command]);
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error("Tangle credential command timeoutMs must be a positive timer bound");
  }
  if (options.minimumValidityMs !== undefined && options.minimumValidUntil !== undefined) {
    throw new Error("Tangle credential command accepts one validity deadline");
  }
  if (options.minimumValidityMs !== undefined &&
    (!Number.isSafeInteger(options.minimumValidityMs) || options.minimumValidityMs <= 0)) {
    throw new Error("Tangle credential command minimumValidityMs must be a positive integer");
  }
  if (options.minimumValidUntil !== undefined &&
    (typeof options.minimumValidUntil !== "string" || options.minimumValidUntil.length > 128)) {
    throw new Error("Tangle credential command validity deadline must be a valid timestamp");
  }
  const deadline = options.minimumValidUntil === undefined
    ? options.minimumValidityMs === undefined ? undefined : new Date(Date.now() + options.minimumValidityMs)
    : new Date(options.minimumValidUntil);
  if (deadline !== undefined && !Number.isFinite(deadline.getTime())) {
    throw new Error("Tangle credential command validity deadline must be a valid timestamp");
  }
  const minimumValidUntil = deadline?.toISOString();
  if (options.env !== undefined && (!options.env || typeof options.env !== "object" || Array.isArray(options.env) ||
    Object.entries(options.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      typeof value !== "string" || value.includes("\0")))) {
    throw new Error("Tangle credential command env must contain valid private process variables");
  }
  const environment = { ...process.env, ...options.env };
  return (input: Readonly<CreateAgentEnvironmentInput>) => {
    if (typeof input.profile === "string") throw new Error("Tangle credential command requires an inline profile");
    if (profileCredentialSource(input.profile) === "router") return undefined;
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0) {
      throw new Error("Tangle credential command requires a stable create idempotencyKey");
    }
    input.signal?.throwIfAborted();
    const { signal, ...data } = input;
    const request = JSON.stringify({ input: data, ...(minimumValidUntil === undefined ? {} : { minimumValidUntil }) });
    return new Promise<TangleModelCredentials>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(command[0]!, command.slice(1), {
          env: environment,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        reject(new Error("Tangle credential command could not start"));
        return;
      }
      // Consume and discard private diagnostics without retaining their content.
      child.stderr.resume();
      let settled = false;
      let outputBytes = 0;
      const chunks: Buffer[] = [];
      // The resolver's refusal reason travels on stderr, one line. Keep the tail bounded; the
      // stdout bound governs the public reference, not this private diagnostic channel.
      const stderrTail: Buffer[] = [];
      let stderrBytes = 0;
      const lastStderrLine = (): string | undefined => {
        const text = Buffer.concat(stderrTail).toString("utf8");
        const line = text
          .split("\n")
          .map((value) => value.trimEnd())
          .filter((value) => value.trim().length > 0)
          // A fatal exit appends Node's own banner and stack lines after the program's output; the
          // resolver's reason is its own prose line, never a runtime stack frame.
          .filter((value) => !/^Node\.js v\d/u.test(value.trim()) && !/^\s+at\s/u.test(value))
          .at(-1);
        if (line === undefined) return undefined;
        return line.length > MAX_STDERR_TAIL_CHARACTERS ? line.slice(0, MAX_STDERR_TAIL_CHARACTERS) : line;
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill("SIGKILL");
        reject(error);
      };
      const onAbort = () => fail(signal?.reason ?? new Error("Tangle credential command aborted"));
      const timer = setTimeout(() => fail(new Error("Tangle credential command timed out")), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", () => fail(new Error("Tangle credential command could not start")));
      child.stdin.on("error", () => fail(new Error("Tangle credential command could not accept its request")));
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
          fail(new Error("Tangle credential command exceeded its public-output bound"));
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        stderrTail.push(chunk);
        // Keep only the bounded tail: the reason is the LAST line a resolver prints.
        while (stderrBytes > MAX_COMMAND_STDERR_BYTES && stderrTail.length > 1) {
          stderrBytes -= stderrTail[0]!.length;
          stderrTail.shift();
        }
      });
      child.on("close", (code, terminationSignal) => {
        if (settled) return;
        if (code !== 0) {
          if (code === 75 || code === 78) {
            let refusal;
            try {
              const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              refusal = code === 75 ? parseCredentialCapacity(payload) : parseCredentialRefusal(payload);
            } catch { /* Malformed command output stays a sanitized generic refusal. */ }
            if (refusal !== undefined) { fail(refusal); return; }
          }
          const stderrTailLine = lastStderrLine();
          if (stderrTailLine !== undefined && RESOLUTION_REFUSAL.test(stderrTailLine)) {
            fail(new TangleCommandCredentialRefusalError(stderrTailLine));
            return;
          }
          fail(Object.assign(new Error(`Tangle credential command failed (${code === null ? `signal ${terminationSignal}` : `exit ${code}`})`), {
            exitCode: code,
            terminationSignal,
            ...(stderrTailLine === undefined ? {} : { stderrTail: stderrTailLine }),
          }));
          return;
        }
        try {
          const selected = captureModelCredentials(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          if (selected === undefined) throw new Error();
          settled = true;
          cleanup();
          resolve(selected);
        } catch {
          fail(new Error("Tangle credential command returned an invalid public reference"));
        }
      });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      child.stdin.end(request + "\n");
    });
  };
}

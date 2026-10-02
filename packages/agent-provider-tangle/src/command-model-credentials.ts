import { parseCredentialCapacity } from "./model-credential-capacity.js";
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
    if (profileCredentialSource(input.profile) === "managed") return undefined;
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
      child.on("close", (code, terminationSignal) => {
        if (settled) return;
        if (code !== 0) {
          if (code === 75) {
            let capacity;
            try { capacity = parseCredentialCapacity(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { /* Malformed command output stays a sanitized generic refusal. */ }
            if (capacity !== undefined) { fail(capacity); return; }
          }
          fail(Object.assign(new Error(`Tangle credential command failed (${code === null ? `signal ${terminationSignal}` : `exit ${code}`})`), {
            exitCode: code,
            terminationSignal,
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

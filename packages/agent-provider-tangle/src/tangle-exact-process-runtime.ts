import type {
  AgentExactProcess,
  AgentExactProcessLaunch,
  AgentExactProcessStatus,
} from "@tangle-network/agent-interface/environment-provider";
import type {
  SandboxProcessLike,
  SandboxProcessStatusLike,
} from "./tangle-types.js";
import {
  awaitWithSignal,
  boundedIdentifier,
  boundedString,
  MAX_ARRAY_LENGTH,
  MAX_EXACT_FILE_BYTES,
} from "./tangle-contract-safety.js";
import { assertAbsoluteFilePath } from "./tangle-exact-process-validation.js";

type AgentCandidateTermination = Awaited<ReturnType<AgentExactProcess["wait"]>>;

export function validateExactProcessLaunch(input: AgentExactProcessLaunch): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Tangle exact process launch must be an object");
  }
  const unsupported = new Set(Object.keys(input));
  for (const key of ["executable", "args", "cwd", "env", "stdin", "timeoutMs"]) {
    unsupported.delete(key);
  }
  if (unsupported.size > 0) throw new Error("Tangle exact process launch contains unsupported fields");
  const executable = boundedProcessString(
    input.executable,
    "Tangle exact process executable",
  );
  if (!Array.isArray(input.args) || input.args.length > MAX_ARRAY_LENGTH) throw new Error("Tangle exact process has too many arguments");
  for (const argument of input.args) boundedProcessString(argument, "Tangle exact process argument");
  if (!input.env || typeof input.env !== "object" || Array.isArray(input.env) || Object.keys(input.env).length > MAX_ARRAY_LENGTH) throw new Error("Tangle exact process environment has too many entries");
  for (const [key, value] of Object.entries(input.env)) {
    boundedIdentifier(key, "Tangle exact process environment key");
    assertNoProcessNul(key, "Tangle exact process environment key");
    boundedProcessString(value, "Tangle exact process environment value");
  }
  if (!executable || (!executable.startsWith("/") && !input.env.PATH?.trim())) {
    throw new Error("Tangle exact process executable must be absolute unless env.PATH is supplied");
  }
  if (executable.startsWith("/")) assertAbsoluteFilePath(executable);
  assertAbsoluteFilePath(input.cwd);
  if (input.stdin !== undefined) boundedProcessString(input.stdin, "Tangle exact process stdin");
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 0 || input.timeoutMs > MAX_EXACT_FILE_BYTES) {
    throw new Error("Tangle exact process timeoutMs must be a non-negative integer");
  }
}

export function sandboxProcessAsExactProcess(process: SandboxProcessLike): AgentExactProcess {
  assertProcessId(process.pid);
  return {
    pid: process.pid,
    async status(options = {}): Promise<AgentExactProcessStatus> {
      assertSignalOptions(options, "Tangle exact process status");
      options.signal?.throwIfAborted();
      const status = await awaitWithSignal(process.status(), options.signal);
      options.signal?.throwIfAborted();
      return exactProcessStatusFromSandbox(status);
    },
    async wait(options = {}): Promise<AgentCandidateTermination> {
      assertSignalOptions(options, "Tangle exact process wait");
      options.signal?.throwIfAborted();
      await awaitWithSignal(process.wait(), options.signal);
      const status = exactProcessStatusFromSandbox(await awaitWithSignal(process.status(), options.signal));
      if (!status.termination) throw new Error("Tangle exact process remained running after wait()");
      return status.termination;
    },
    async kill(options = {}): Promise<void> {
      assertSignalOptions(options, "Tangle exact process kill");
      options.signal?.throwIfAborted();
      await awaitWithSignal(process.kill("SIGKILL", { tree: true }), options.signal);
      options.signal?.throwIfAborted();
    },
    async *stdout(options = {}): AsyncIterable<string> {
      assertSignalOptions(options, "Tangle exact process stdout");
      options.signal?.throwIfAborted();
      yield* boundedProcessOutput(process.stdout(), options.signal, "Tangle exact process stdout");
    },
    async *stderr(options = {}): AsyncIterable<string> {
      assertSignalOptions(options, "Tangle exact process stderr");
      options.signal?.throwIfAborted();
      yield* boundedProcessOutput(process.stderr(), options.signal, "Tangle exact process stderr");
    },
  };
}

async function* boundedProcessOutput(
  source: AsyncIterable<string>,
  signal: AbortSignal | undefined,
  label: string,
): AsyncIterable<string> {
  const iterator = source[Symbol.asyncIterator]();
  let completed = false;
  let bytes = 0;
  try {
    while (true) {
      const next = await awaitWithSignal(iterator.next(), signal);
      if (next.done) {
        completed = true;
        break;
      }
      signal?.throwIfAborted();
      const bounded = boundedString(next.value, label);
      bytes += Buffer.byteLength(bounded, "utf8");
      if (bytes > MAX_EXACT_FILE_BYTES) {
        throw new Error(`${label} exceeded its byte bound`);
      }
      yield bounded;
    }
  } finally {
    if (!completed) {
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    }
  }
}

export function exactProcessStatusFromSandbox(status: SandboxProcessStatusLike): AgentExactProcessStatus {
  if (!status || typeof status !== "object") throw new Error("Tangle exact process returned no status");
  assertProcessId(status.pid);
  if (typeof status.running !== "boolean") throw new Error("Tangle exact process status has no running flag");
  if (!Number.isSafeInteger(status.exitCode)) throw new Error("Tangle exact process status has an invalid exit code");
  if (status.running ? status.exitCode !== -1 : status.exitCode < 0) {
    throw new Error("Tangle exact process status has an invalid exit state");
  }
  if (status.exitSignal !== undefined) boundedIdentifier(status.exitSignal, "Tangle exact process exit signal");
  if (status.running && status.exitSignal) throw new Error("Tangle exact process reported an exit signal while running");
  const termination = processTermination(status);
  return {
    pid: status.pid,
    running: status.running,
    exitCode: status.exitCode,
    ...(status.exitSignal ? { exitSignal: status.exitSignal } : {}),
    ...(termination ? { termination } : {}),
  };
}

function processTermination(status: SandboxProcessStatusLike): AgentCandidateTermination | undefined {
  if (status.running) return undefined;
  return status.exitSignal ? { kind: "signal", signal: status.exitSignal } : { kind: "exit", exitCode: status.exitCode };
}

function assertProcessId(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Tangle exact process pid is invalid");
}

function boundedProcessString(value: unknown, label: string): string {
  const bounded = boundedString(value, label);
  assertNoProcessNul(bounded, label);
  return bounded;
}

function assertNoProcessNul(value: string, label: string): void {
  if (value.includes("\0")) throw new Error(`${label} contains a NUL byte`);
}

function assertSignalOptions(value: { signal?: AbortSignal }, label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} options must be an object`);
  for (const key of Object.keys(value)) {
    if (key !== "signal") throw new Error(`${label} options contain unsupported field ${key}`);
  }
}

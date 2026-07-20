import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CreateSandboxOptions } from "@tangle-network/sandbox";
import type { AgentCandidateTermination } from "@tangle-network/agent-interface";
import type {
  AgentExactProcess,
  AgentExactProcessEnvironment,
  AgentExactProcessLaunch,
  AgentExactProcessProvider,
  AgentExactProcessStatus,
  CreateAgentExactProcessEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";
import type {
  SandboxClientLike,
  SandboxInstanceLike,
  SandboxProcessLike,
  SandboxProcessStatusLike,
} from "./index.js";

const IMMUTABLE_TANGLE_IMAGE =
  /^(?:sha256:[a-f0-9]{64}|\S+@sha256:[a-f0-9]{64})$/i;
const EXACT_PROCESS_METADATA_KEY = "tangle.exactProcess";
const LIST_PAGE_SIZE = 1_000;
const MAX_LIST_OFFSET = 1_000;

type TangleExactSandboxOptions = Omit<
  CreateSandboxOptions,
  "agent" | "driver" | "egressPolicy"
> & {
  agent: false;
  driver: { type: "host-agent"; runtimeBackend: "docker" };
  egressPolicy:
    | { mode: "blocked" }
    | {
        mode: "strict";
        allowDomains: string[];
        includeImplicitDomains: false;
      };
};

export interface TangleExactProcessOptions {
  teamId?: string;
}

export function createTangleExactProcessProvider(input: {
  client: SandboxClientLike;
  options: TangleExactProcessOptions;
  providerName: string;
}): AgentExactProcessProvider {
  const { client, options, providerName } = input;
  const get = client.get;
  const list = client.list;
  if (!get || !list) {
    throw new Error("Tangle exact process provider requires get() and list()");
  }
  return {
    async create(createInput): Promise<AgentExactProcessEnvironment> {
      assertSupportedProviderOptions(createInput.providerOptions);
      assertUnreservedMetadata(createInput.metadata);
      const box = await client.create(exactSandboxOptions(createInput, options), {
        ...(createInput.signal ? { signal: createInput.signal } : {}),
        ...(createInput.provisionTimeoutMs === undefined
          ? {}
          : { timeoutMs: createInput.provisionTimeoutMs }),
      });
      try {
        assertExactProcessSandbox(box);
        return sandboxInstanceAsExactProcessEnvironment(box, providerName);
      } catch (error) {
        if (!box.delete) throw error;
        try {
          await box.delete();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Tangle exact process validation and cleanup both failed",
          );
        }
        throw error;
      }
    },
    async get(id): Promise<AgentExactProcessEnvironment | null> {
      const box = await get.call(client, id);
      if (!box || !isExactProcessSandbox(box)) return null;
      return sandboxInstanceAsExactProcessEnvironment(box, providerName);
    },
    async list(query): Promise<AgentExactProcessEnvironment[]> {
      assertSupportedProviderOptions(query?.providerOptions);
      const matches: AgentExactProcessEnvironment[] = [];
      for (let offset = 0; offset <= MAX_LIST_OFFSET; offset += LIST_PAGE_SIZE) {
        const page = await list.call(client, {
          ...(options.teamId
            ? { scope: `team:${options.teamId}` }
            : { scope: "personal" }),
          limit: LIST_PAGE_SIZE,
          offset,
        });
        for (const box of page) {
          if (
            isExactProcessSandbox(box) &&
            metadataMatches(box.metadata, query?.metadata)
          ) {
            matches.push(
              sandboxInstanceAsExactProcessEnvironment(box, providerName),
            );
          }
        }
        if (page.length < LIST_PAGE_SIZE) return matches;
      }
      throw new Error(
        "Tangle exact process lookup exceeds the Sandbox list pagination limit",
      );
    },
  };
}

function exactSandboxOptions(
  input: CreateAgentExactProcessEnvironmentInput,
  defaults: TangleExactProcessOptions,
): TangleExactSandboxOptions {
  if (!input.image.trim()) throw new Error("exact process image is required");
  if (!IMMUTABLE_TANGLE_IMAGE.test(input.image)) {
    throw new Error(
      "Tangle exact process image must include a sha256 manifest digest",
    );
  }
  if (!input.idempotencyKey.trim()) {
    throw new Error("exact process idempotencyKey is required");
  }
  if (
    !Number.isSafeInteger(input.maxLifetimeMs) ||
    input.maxLifetimeMs < 1 ||
    input.maxLifetimeMs % 1_000 !== 0
  ) {
    throw new Error(
      "Tangle exact process maxLifetimeMs must be a positive whole number of seconds",
    );
  }
  if (
    input.provisionTimeoutMs !== undefined &&
    (!Number.isSafeInteger(input.provisionTimeoutMs) ||
      input.provisionTimeoutMs < 1)
  ) {
    throw new Error(
      "exact process provisionTimeoutMs must be a positive integer",
    );
  }
  if (
    input.egress.mode === "strict" &&
    input.egress.allowDomains.length === 0
  ) {
    throw new Error("strict exact process egress requires at least one domain");
  }
  const resources = sandboxResourcesFromRequest(input.resources);
  return {
    image: input.image,
    agent: false,
    driver: { type: "host-agent", runtimeBackend: "docker" },
    publicEdge: false,
    ephemeral: true,
    sshEnabled: false,
    webTerminalEnabled: false,
    secrets: [],
    capabilities: [],
    egressPolicy:
      input.egress.mode === "blocked"
        ? { mode: "blocked" }
        : {
            mode: "strict",
            allowDomains: [...input.egress.allowDomains],
            includeImplicitDomains: false,
          },
    maxLifetimeSeconds: input.maxLifetimeMs / 1_000,
    idempotencyKey: input.idempotencyKey,
    metadata: {
      ...input.metadata,
      [EXACT_PROCESS_METADATA_KEY]: true,
    },
    ...(defaults.teamId ? { teamId: defaults.teamId } : {}),
    resources,
  };
}

function sandboxResourcesFromRequest(
  requested: CreateAgentExactProcessEnvironmentInput["resources"],
): NonNullable<CreateSandboxOptions["resources"]> {
  if (!Number.isFinite(requested.cpu) || requested.cpu <= 0) {
    throw new Error("Tangle exact process CPU must be positive and finite");
  }
  if (!Number.isSafeInteger(requested.memoryMb) || requested.memoryMb < 1) {
    throw new Error(
      "Tangle exact process memoryMb must be a positive integer",
    );
  }
  if (
    !Number.isSafeInteger(requested.diskMb) ||
    requested.diskMb < 1 ||
    requested.diskMb % 1_024 !== 0
  ) {
    throw new Error(
      "Tangle exact process diskMb must be a positive whole number of gibibytes",
    );
  }
  return {
    cpuCores: requested.cpu,
    memoryMB: requested.memoryMb,
    diskGB: requested.diskMb / 1_024,
  };
}

function sandboxInstanceAsExactProcessEnvironment(
  box: SandboxInstanceLike,
  providerName: string,
): AgentExactProcessEnvironment {
  if (
    !box.fs ||
    box.fs.supportsWriteMode !== true ||
    !box.process ||
    !box.delete
  ) {
    throw new Error(
      "Tangle sandbox does not expose exact files, processes, and deletion",
    );
  }
  const process = box.process;
  const fs = box.fs;
  const destroy = box.delete.bind(box);
  return {
    id: String(box.id),
    provider: providerName,
    ...(box.metadata ? { metadata: box.metadata } : {}),
    process: {
      async list(): Promise<AgentExactProcessStatus[]> {
        return (await process.list()).map(exactProcessStatusFromSandbox);
      },
      async get(pid: number): Promise<AgentExactProcess | null> {
        const handle = await process.get(pid);
        return handle ? sandboxProcessAsExactProcess(handle) : null;
      },
      async spawn(
        launch: AgentExactProcessLaunch,
        operation = {},
      ): Promise<AgentExactProcess> {
        operation.signal?.throwIfAborted();
        validateExactProcessLaunch(launch);
        const handle = await process.spawnExact(
          launch.executable,
          launch.args,
          {
            cwd: launch.cwd,
            env: { ...launch.env },
            inheritEnv: false,
            ...(launch.stdin === undefined ? {} : { stdin: launch.stdin }),
            timeoutMs: launch.timeoutMs,
            ...(operation.signal ? { signal: operation.signal } : {}),
          },
        );
        operation.signal?.throwIfAborted();
        return sandboxProcessAsExactProcess(handle);
      },
    },
    async writeFile(path, bytes, options): Promise<void> {
      options.signal?.throwIfAborted();
      assertAbsoluteFilePath(path);
      if (
        !Number.isSafeInteger(options.mode) ||
        options.mode < 0 ||
        options.mode > 0o7777
      ) {
        throw new Error(
          "Tangle exact process file mode must be between 0 and 07777",
        );
      }
      await fs.write(path, Buffer.from(bytes).toString("base64"), {
        encoding: "base64",
        mode: options.mode,
      });
      options.signal?.throwIfAborted();
    },
    async readFile(path, options): Promise<Uint8Array> {
      options.signal?.throwIfAborted();
      assertAbsoluteFilePath(path);
      if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
        throw new Error(
          "Tangle exact process maxBytes must be a positive integer",
        );
      }
      const stat = await fs.stat(path);
      options.signal?.throwIfAborted();
      if (!stat.isFile) {
        throw new Error("Tangle exact process path is not a regular file");
      }
      if (stat.size > options.maxBytes) {
        throw new Error("Tangle exact process file exceeds maxBytes");
      }
      const result = await fs.readBatch([path], { encoding: "base64" });
      options.signal?.throwIfAborted();
      const file = result.files[0];
      if (
        result.errors.length !== 0 ||
        result.files.length !== 1 ||
        !file ||
        file.path !== path ||
        file.encoding !== "base64"
      ) {
        throw new Error(
          result.errors[0]?.error ??
            "Tangle exact process file read returned an invalid result",
        );
      }
      const bytes = Uint8Array.from(Buffer.from(file.content, "base64"));
      if (
        bytes.byteLength !== file.size ||
        bytes.byteLength !== stat.size ||
        bytes.byteLength > options.maxBytes
      ) {
        throw new Error(
          "Tangle exact process file read violated its byte bound",
        );
      }
      return bytes;
    },
    async destroy(): Promise<void> {
      await destroy();
    },
  };
}

function validateExactProcessLaunch(input: AgentExactProcessLaunch): void {
  if (
    !input.executable ||
    (!isAbsolute(input.executable) && !input.env.PATH?.trim())
  ) {
    throw new Error(
      "Tangle exact process executable must be absolute unless env.PATH is supplied",
    );
  }
  if (!input.cwd) throw new Error("Tangle exact process cwd is required");
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 0) {
    throw new Error(
      "Tangle exact process timeoutMs must be a non-negative integer",
    );
  }
}

function sandboxProcessAsExactProcess(
  process: SandboxProcessLike,
): AgentExactProcess {
  return {
    pid: process.pid,
    async status(): Promise<AgentExactProcessStatus> {
      return exactProcessStatusFromSandbox(await process.status());
    },
    async wait(): Promise<AgentCandidateTermination> {
      await process.wait();
      const status = exactProcessStatusFromSandbox(await process.status());
      if (!status.termination) {
        throw new Error("Tangle exact process remained running after wait()");
      }
      return status.termination;
    },
    async kill(): Promise<void> {
      await process.kill("SIGKILL", { tree: true });
    },
    async *stdout(): AsyncIterable<string> {
      yield* process.stdout();
    },
    async *stderr(): AsyncIterable<string> {
      yield* process.stderr();
    },
  };
}

function exactProcessStatusFromSandbox(
  status: SandboxProcessStatusLike,
): AgentExactProcessStatus {
  if (status.running && status.exitSignal) {
    throw new Error("Tangle exact process reported an exit signal while running");
  }
  const termination = processTermination(status);
  return {
    pid: status.pid,
    running: status.running,
    exitCode: status.exitCode,
    ...(status.exitSignal ? { exitSignal: status.exitSignal } : {}),
    ...(termination ? { termination } : {}),
  };
}

function processTermination(
  status: SandboxProcessStatusLike,
): AgentCandidateTermination | undefined {
  if (status.running) return undefined;
  return status.exitSignal
    ? { kind: "signal", signal: status.exitSignal }
    : { kind: "exit", exitCode: status.exitCode };
}

function assertExactProcessSandbox(box: SandboxInstanceLike): void {
  if (!isExactProcessSandbox(box)) {
    throw new Error(
      "Tangle Sandbox did not create the requested process-only runtime",
    );
  }
}

function isExactProcessSandbox(box: SandboxInstanceLike): boolean {
  return (
    box.metadata?.runtimeMode === "control" &&
    box.metadata[EXACT_PROCESS_METADATA_KEY] === true
  );
}

function assertUnreservedMetadata(metadata: Record<string, unknown>): void {
  const reserved = [
    "capabilities",
    "customer_id",
    "exactProcess",
    "integrationLaunch",
    "runtimeMode",
    "teamId",
    EXACT_PROCESS_METADATA_KEY,
  ];
  if (reserved.some((name) => Object.hasOwn(metadata, name))) {
    throw new Error("exact process ownership metadata is reserved by Tangle");
  }
}

function assertSupportedProviderOptions(
  providerOptions: Record<string, unknown> | undefined,
): void {
  if (providerOptions && Object.keys(providerOptions).length > 0) {
    throw new Error("Tangle exact process providerOptions are not supported");
  }
}

function assertAbsoluteFilePath(path: string): void {
  if (!isAbsolute(path)) {
    throw new Error("Tangle exact process file path must be absolute");
  }
}

function metadataMatches(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, unknown> | undefined,
): boolean {
  if (!expected) return true;
  if (!actual) return false;
  return Object.entries(expected).every(([key, value]) =>
    isDeepStrictEqual(actual[key], value),
  );
}

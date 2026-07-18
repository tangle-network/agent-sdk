import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  createExactProcessAttestation,
  type CreateSandboxOptions,
  type ExactProcessAttestation,
  parseExactProcessAttestation,
} from "@tangle-network/sandbox";
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

const IMMUTABLE_TANGLE_IMAGE = /^(?:sha256:[a-f0-9]{64}|\S+@sha256:[a-f0-9]{64})$/i;

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
  if (!get || !list) throw new Error("Tangle exact process provider requires get() and list()");
  return {
    async create(createInput): Promise<AgentExactProcessEnvironment> {
      if (
        createInput.providerOptions &&
        Object.keys(createInput.providerOptions).length > 0
      ) {
        throw new Error("Tangle exact process providerOptions are not supported");
      }
      if (
        Object.hasOwn(createInput.metadata, "capabilities") ||
        Object.hasOwn(createInput.metadata, "customer_id") ||
        Object.hasOwn(createInput.metadata, "exactProcess") ||
        Object.hasOwn(createInput.metadata, "integrationLaunch") ||
        Object.hasOwn(createInput.metadata, "teamId")
      ) {
        throw new Error("exact process ownership metadata is reserved by Tangle");
      }
      const createOptions = exactSandboxOptions(createInput, options);
      const expectedAttestation = await createExactProcessAttestation(createOptions);
      const box = await client.create(createOptions, {
        ...(createInput.signal ? { signal: createInput.signal } : {}),
        ...(createInput.provisionTimeoutMs === undefined
          ? {}
          : { timeoutMs: createInput.provisionTimeoutMs }),
      });
      const attestation = exactProcessAttestation(box, options.teamId);
      if (!attestation) {
        throw new Error("Tangle Sandbox did not attest the requested exact process mode");
      }
      if (!isDeepStrictEqual(attestation, expectedAttestation)) {
        throw new Error(
          "Tangle exact process idempotency collision returned different create inputs",
        );
      }
      return sandboxInstanceAsExactProcessEnvironment(box, providerName);
    },
    async get(id): Promise<AgentExactProcessEnvironment | null> {
      const box = await get.call(client, id);
      return box && isExactProcessSandbox(box, options.teamId)
        ? sandboxInstanceAsExactProcessEnvironment(box, providerName)
        : null;
    },
    async list(query): Promise<AgentExactProcessEnvironment[]> {
      if (
        query?.providerOptions &&
        Object.keys(query.providerOptions).length > 0
      ) {
        throw new Error("Tangle exact process query providerOptions are not supported");
      }
      const matches: AgentExactProcessEnvironment[] = [];
      for (let offset = 0; ; offset += 100) {
        const page = await list.call(client, {
          ...(options.teamId ? { scope: `team:${options.teamId}` } : { scope: "personal" }),
          limit: 100,
          offset,
        });
        for (const box of page) {
          if (
            isExactProcessSandbox(box, options.teamId) &&
            metadataMatches(box.metadata, query?.metadata)
          ) {
            matches.push(sandboxInstanceAsExactProcessEnvironment(box, providerName));
          }
        }
        if (page.length < 100) break;
      }
      return matches;
    },
  };
}

function exactSandboxOptions(
  input: CreateAgentExactProcessEnvironmentInput,
  defaults: TangleExactProcessOptions,
): CreateSandboxOptions {
  if (!input.image.trim()) throw new Error("exact process image is required");
  if (!IMMUTABLE_TANGLE_IMAGE.test(input.image)) {
    throw new Error("Tangle exact process image must include a sha256 manifest digest");
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
    (!Number.isSafeInteger(input.provisionTimeoutMs) || input.provisionTimeoutMs < 1)
  ) {
    throw new Error("exact process provisionTimeoutMs must be a positive integer");
  }
  if (input.egress.mode === "strict" && input.egress.allowDomains.length === 0) {
    throw new Error("strict exact process egress requires at least one domain");
  }
  if (!input.resources) {
    throw new Error("Tangle exact process resources are required");
  }
  const resources = sandboxResourcesFromRequest(input.resources);
  return {
    image: input.image,
    exactProcess: true,
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
    metadata: { ...input.metadata },
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
    throw new Error("Tangle exact process memoryMb must be a positive integer");
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
    typeof box.fs.readBytes !== "function" ||
    !box.process ||
    !box.delete
  ) {
    throw new Error("Tangle sandbox does not expose exact files, processes, and deletion");
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
        const handle = await process.spawnExact(launch.executable, launch.args, {
          cwd: launch.cwd,
          env: { ...launch.env },
          inheritEnv: false,
          ...(launch.stdin === undefined ? {} : { stdin: launch.stdin }),
          timeoutMs: launch.timeoutMs,
          ...(operation.signal ? { signal: operation.signal } : {}),
        });
        return sandboxProcessAsExactProcess(handle);
      },
    },
    async writeFile(path, bytes, options): Promise<void> {
      options.signal?.throwIfAborted();
      if (!isAbsolute(path)) {
        throw new Error("Tangle exact process file path must be absolute");
      }
      if (!Number.isSafeInteger(options.mode) || options.mode < 0 || options.mode > 0o7777) {
        throw new Error("Tangle exact process file mode must be between 0 and 07777");
      }
      await fs.write(path, Buffer.from(bytes).toString("base64"), {
        encoding: "base64",
        mode: options.mode,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    },
    async readFile(path, options): Promise<Uint8Array> {
      options.signal?.throwIfAborted();
      if (!isAbsolute(path)) {
        throw new Error("Tangle exact process file path must be absolute");
      }
      if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
        throw new Error("Tangle exact process maxBytes must be a positive integer");
      }
      const bytes = await fs.readBytes(path, {
        maxBytes: options.maxBytes,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (bytes.byteLength > options.maxBytes) {
        throw new Error("Tangle exact process file read violated its byte limit");
      }
      return bytes;
    },
    async destroy(): Promise<void> {
      await destroy();
    },
  };
}

function validateExactProcessLaunch(input: AgentExactProcessLaunch): void {
  if (!input.executable || (!isAbsolute(input.executable) && !input.env.PATH)) {
    throw new Error(
      "Tangle exact process executable must be absolute unless env.PATH is supplied",
    );
  }
  if (!input.cwd) throw new Error("Tangle exact process cwd is required");
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 0) {
    throw new Error("Tangle exact process timeoutMs must be a non-negative integer");
  }
}

function sandboxProcessAsExactProcess(process: SandboxProcessLike): AgentExactProcess {
  return {
    pid: process.pid,
    async status(): Promise<AgentExactProcessStatus> {
      return exactProcessStatusFromSandbox(await process.status());
    },
    async wait() {
      return process.waitForTermination();
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

function isExactProcessSandbox(
  box: SandboxInstanceLike,
  teamId: string | undefined,
): boolean {
  return exactProcessAttestation(box, teamId) !== undefined;
}

function exactProcessAttestation(
  box: SandboxInstanceLike,
  teamId: string | undefined,
): ExactProcessAttestation | undefined {
  const attestation = parseExactProcessAttestation(box.exactProcess);
  if (!attestation) return undefined;
  if (teamId ? box.teamId !== teamId : box.teamId !== undefined) return undefined;
  return attestation;
}

function exactProcessStatusFromSandbox(
  status: SandboxProcessStatusLike,
): AgentExactProcessStatus {
  if (status.running && status.termination) {
    throw new Error("Tangle exact process reported a terminal reason while running");
  }
  if (!status.running && !status.termination) {
    throw new Error("Tangle exact process reported no terminal reason after exit");
  }
  return {
    pid: status.pid,
    running: status.running,
    exitCode: status.exitCode,
    ...(status.exitSignal ? { exitSignal: status.exitSignal } : {}),
    ...(status.termination ? { termination: status.termination } : {}),
  };
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

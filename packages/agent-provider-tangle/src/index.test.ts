import { describe, expect, it, vi } from "vitest";
import {
  runAgentEnvironmentProviderConformance,
  runAgentExactProcessProviderLifecycleChecks,
} from "@tangle-network/agent-provider-testkit";
import type {
  CreateSandboxOptions,
  SandboxEvent,
} from "@tangle-network/sandbox";
import {
  createTangleProvider,
  defaultTangleSandboxCapabilities,
  type SandboxClientLike,
  type SandboxInstanceLike,
} from "./index.js";

const EXACT_IMAGE = `example/image@sha256:${"1".repeat(64)}`;
const EXACT_RESOURCES = { cpu: 1, memoryMb: 512, diskMb: 1024 } as const;

type ExactCreateOptions = CreateSandboxOptions & {
  agent?: boolean;
  driver?: { type: string; runtimeBackend?: string };
  egressPolicy?: {
    mode: string;
    allowDomains?: string[];
    includeImplicitDomains?: boolean;
  };
};

describe("createTangleProvider", () => {
  it("refuses to advertise exact processes without the exact adapter", async () => {
    const provider = createTangleProvider({
      client: {
        async create() {
          throw new Error("not called");
        },
      },
      capabilities: {
        ...defaultTangleSandboxCapabilities(),
        exactProcess: { egress: ["blocked"] },
      },
    });

    await expect(provider.capabilities()).rejects.toThrow(
      "cannot advertise exactProcess",
    );
    expect(defaultTangleSandboxCapabilities()).not.toHaveProperty(
      "exactProcess",
    );
  });

  it("maps ordinary agent environments", async () => {
    let createOptions: CreateSandboxOptions | undefined;
    const files = new Map<string, string>();
    const box: SandboxInstanceLike = {
      id: "sbx-1",
      name: "sandbox-one",
      status: "running",
      async *streamPrompt(prompt: string): AsyncIterable<SandboxEvent> {
        yield {
          type: "result",
          data: {
            finalText: `ok:${prompt}`,
            usage: {
              inputTokens: 2,
              outputTokens: 3,
              totalCostUsd: 0.01,
            },
          },
        } as SandboxEvent;
      },
      dispatchPrompt: async () => ({
        sessionId: "sess-1",
        status: "running",
        alreadyExisted: true,
      }),
      read: async (path) => files.get(path) ?? "",
      write: async (path, content) => {
        files.set(path, content);
      },
      exec: async () => ({ exitCode: 0, stdout: "ok\n", stderr: "" }),
      delete: async () => {},
    };
    const client: SandboxClientLike = {
      async create(options) {
        createOptions = options;
        return box;
      },
      describePlacement: () => ({ kind: "sibling", sandboxId: "sbx-1" }),
    };
    const provider = createTangleProvider({ client });

    await expect(
      runAgentEnvironmentProviderConformance({
        name: "sandbox",
        createProvider: () => provider,
        createInput: { profile: { name: "worker" }, backend: "codex" },
      }),
    ).resolves.toMatchObject({ provider: "tangle-sandbox" });

    expect(createOptions).toMatchObject({
      backend: { type: "codex", profile: { name: "worker" } },
    });
  });

  it("runs the exact-process lifecycle through process-only sandboxes", async () => {
    let firstCreateOptions: ExactCreateOptions | undefined;
    let createRequestOptions:
      | { signal?: AbortSignal; timeoutMs?: number }
      | undefined;
    let listOptions: Record<string, unknown> | undefined;
    let writeOptions: Record<string, unknown> | undefined;
    let launchOptions: Record<string, unknown> | undefined;
    let readBatchCalls = 0;
    let killCalls = 0;
    let nextId = 1;
    const records = new Map<
      string,
      {
        signature: string;
        box: SandboxInstanceLike;
        deleted: boolean;
      }
    >();

    const client: SandboxClientLike = {
      async create(rawOptions, requestOptions) {
        const options = rawOptions as ExactCreateOptions;
        const key = options.idempotencyKey ?? `unkeyed-${nextId}`;
        const signature = JSON.stringify(options);
        const existing = records.get(key);
        if (existing) {
          if (existing.signature !== signature) {
            throw new Error("idempotency collision");
          }
          existing.deleted = false;
          return existing.box;
        }

        firstCreateOptions ??= options;
        createRequestOptions ??= requestOptions;
        const files = new Map<string, Uint8Array>();
        let spawned = false;
        const status = {
          pid: 73,
          running: false,
          exitCode: 0,
        };
        const process = {
          pid: status.pid,
          status: async () => status,
          wait: async () => status.exitCode,
          kill: async () => {
            killCalls += 1;
          },
          async *stdout() {
            yield "ok";
          },
          async *stderr() {},
        };
        const id = `exact-${nextId++}`;
        const record = {
          signature,
          deleted: false,
          box: undefined as unknown as SandboxInstanceLike,
        };
        const box: SandboxInstanceLike = {
          id,
          status: "running",
          metadata: {
            ...(options.metadata ?? {}),
            runtimeMode: options.agent === false ? "control" : "agent",
          },
          async *streamPrompt(): AsyncIterable<SandboxEvent> {},
          fs: {
            supportsWriteMode: true,
            async stat(path) {
              const bytes = files.get(path);
              if (!bytes) throw new Error("not found");
              return { size: bytes.byteLength, isFile: true };
            },
            async readBatch(paths, readOptions) {
              readBatchCalls += 1;
              const found = paths.flatMap((path) => {
                const bytes = files.get(path);
                return bytes
                  ? [
                      {
                        path,
                        content: Buffer.from(bytes).toString("base64"),
                        encoding: "base64" as const,
                        size: bytes.byteLength,
                      },
                    ]
                  : [];
              });
              return {
                files: found,
                errors: paths
                  .filter((path) => !files.has(path))
                  .map((path) => ({ path, error: "not found" })),
              };
            },
            async write(path, content, options) {
              writeOptions = options;
              files.set(path, Uint8Array.from(Buffer.from(content, "base64")));
            },
          },
          process: {
            list: async () => (spawned ? [status] : []),
            get: async (pid) =>
              spawned && pid === process.pid ? process : null,
            async spawnExact(_executable, _args, options) {
              spawned = true;
              launchOptions = options;
              return process;
            },
          },
          async delete() {
            record.deleted = true;
          },
        };
        record.box = box;
        records.set(key, record);
        return box;
      },
      async get(id) {
        for (const record of records.values()) {
          if (record.box.id === id && !record.deleted) return record.box;
        }
        return null;
      },
      async list(options) {
        listOptions = options as Record<string, unknown>;
        const visible = [...records.values()]
          .filter((record) => !record.deleted)
          .map((record) => record.box);
        const offset = Number(listOptions.offset ?? 0);
        const limit = Number(listOptions.limit ?? 1_000);
        return visible.slice(offset, offset + limit);
      },
    };
    const provider = createTangleProvider({
      client,
      exactProcess: { teamId: "team-1" },
    });

    await expect(
      runAgentExactProcessProviderLifecycleChecks({
        createProvider: () => provider,
        createInput: {
          image: EXACT_IMAGE,
          egress: { mode: "strict", allowDomains: ["model.example"] },
          maxLifetimeMs: 61_000,
          provisionTimeoutMs: 3_000,
          resources: EXACT_RESOURCES,
          metadata: { executionId: "execution-1" },
          idempotencyKey: "candidate-1",
        },
        launch: {
          executable: "/usr/bin/agent",
          args: ["--prompt", "hello world"],
          cwd: "/workspace",
          env: { MODEL_URL: "http://model.internal" },
          stdin: "input",
          timeoutMs: 2_000,
        },
        expectedStdout: "ok",
        expectedStderr: "",
      }),
    ).resolves.toMatchObject({
      provider: "tangle-sandbox",
      environmentId: "exact-1",
    });

    expect(firstCreateOptions).toEqual({
      image: EXACT_IMAGE,
      agent: false,
      driver: { type: "host-agent", runtimeBackend: "docker" },
      publicEdge: false,
      ephemeral: true,
      sshEnabled: false,
      webTerminalEnabled: false,
      secrets: [],
      capabilities: [],
      egressPolicy: {
        mode: "strict",
        allowDomains: ["model.example"],
        includeImplicitDomains: false,
      },
      maxLifetimeSeconds: 61,
      idempotencyKey: "candidate-1",
      metadata: {
        executionId: "execution-1",
        "tangle.exactProcess": true,
      },
      teamId: "team-1",
      resources: { cpuCores: 1, memoryMB: 512, diskGB: 1 },
    });
    expect(createRequestOptions?.timeoutMs).toBe(3_000);
    expect(writeOptions).toEqual({ encoding: "base64", mode: 0o640 });
    expect(launchOptions).toMatchObject({
      cwd: "/workspace",
      env: { MODEL_URL: "http://model.internal" },
      inheritEnv: false,
      stdin: "input",
      timeoutMs: 2_000,
      signal: expect.any(AbortSignal),
    });
    expect(listOptions).toMatchObject({
      scope: "team:team-1",
      limit: 1_000,
      offset: 0,
    });
    expect(readBatchCalls).toBe(1);
    expect(killCalls).toBe(1);
  });

  it("deletes a sandbox when the API cannot prove process-only mode", async () => {
    const deleted = vi.fn(async () => undefined);
    const box: SandboxInstanceLike = {
      id: "unproven",
      metadata: { "tangle.exactProcess": true },
      async *streamPrompt(): AsyncIterable<SandboxEvent> {},
      delete: deleted,
    };
    const provider = createTangleProvider({
      client: {
        async create() {
          return box;
        },
        async get() {
          return box;
        },
        async list() {
          return [box];
        },
      },
      exactProcess: {},
    });

    await expect(
      provider.exactProcess?.create({
        image: EXACT_IMAGE,
        egress: { mode: "blocked" },
        maxLifetimeMs: 10_000,
        resources: EXACT_RESOURCES,
        metadata: { executionId: "unproven" },
        idempotencyKey: "candidate-unproven",
      }),
    ).rejects.toThrow("did not create the requested process-only runtime");
    expect(deleted).toHaveBeenCalledOnce();
    await expect(provider.exactProcess?.get(box.id)).resolves.toBeNull();
  });

  it("rejects caller ownership markers", async () => {
    const provider = createTangleProvider({
      client: {
        async create() {
          throw new Error("not called");
        },
        async get() {
          return null;
        },
        async list() {
          return [];
        },
      },
      exactProcess: {},
    });

    await expect(
      provider.exactProcess?.create({
        image: EXACT_IMAGE,
        egress: { mode: "blocked" },
        maxLifetimeMs: 10_000,
        resources: EXACT_RESOURCES,
        metadata: { runtimeMode: "control" },
        idempotencyKey: "candidate-reserved",
      }),
    ).rejects.toThrow("metadata is reserved");
  });
});

import { describe, expect, it } from "vitest";
import type {
  AgentEnvironmentProvider,
  AgentExactProcessEnvironment,
  AgentTurnInput,
} from "@tangle-network/agent-interface/environment-provider";
import {
  runAgentEnvironmentProviderConformance,
  runAgentExactProcessProviderLifecycleChecks,
} from "./index.js";

describe("runAgentEnvironmentProviderConformance", () => {
  it("accepts a provider that implements the required lifecycle", async () => {
    const report = await runAgentEnvironmentProviderConformance({
      name: "fake",
      createProvider: () => fakeProvider(),
    });

    expect(report.provider).toBe("fake");
    expect(report.checked).toContain("stream");
    expect(report.checked).toContain("workspace-exec");
  });
});

describe("runAgentExactProcessProviderLifecycleChecks", () => {
  it("checks exact launch, recovery, lookup, and deletion", async () => {
    const report = await runAgentExactProcessProviderLifecycleChecks({
      createProvider: () => fakeExactProcessProvider(),
      createInput: {
        image: "example@sha256:123",
        egress: { mode: "blocked" },
        maxLifetimeMs: 10_000,
        resources: { cpu: 1, memoryMb: 512, diskMb: 1024 },
        metadata: { executionId: "execution-1" },
        idempotencyKey: "execution-1",
      },
      launch: {
        executable: "/bin/example",
        args: ["ok"],
        cwd: "/tmp",
        env: {},
        timeoutMs: 1_000,
        idempotencyKey: "execution-1-process",
        retentionMs: 60_000,
      },
      expectedStdout: "ok",
      expectedStderr: "",
    });

    expect(report.checked).toEqual([
      "exact-process-capability",
      "exact-process-idempotency",
      "exact-process-idempotency-collision",
      "fresh-environment",
      "exact-file-roundtrip",
      "exact-process-launch-idempotency",
      "exact-process-run",
      "exact-process-recovery",
      "exact-process-list",
      "exact-process-destroy",
    ]);
  });
});

function fakeProvider(): AgentEnvironmentProvider {
  const files = new Map<string, string>();
  return {
    name: "fake",
    capabilities: () => ({
      profile: {
        namedProfiles: true,
        systemPrompt: true,
        instructions: true,
        tools: true,
        permissions: true,
        mcp: true,
        subagents: true,
        resources: {
          files: true,
          instructions: true,
          tools: true,
          skills: true,
          agents: true,
          commands: true,
        },
        hooks: true,
        modes: true,
        runtimeUpdate: true,
        validation: true,
      },
      streaming: { live: true, replay: false, detach: false, turnIdempotency: true },
      sessions: { continue: true, list: false, messages: false },
      workspace: { read: true, write: true, exec: true, git: false, upload: false, download: false },
      branching: { checkpoint: false, fork: false },
      placement: false,
      usage: true,
      confidential: false,
    }),
    async create() {
      return {
        id: "env-1",
        provider: "fake",
        status: async () => "running",
        async *stream(input: AgentTurnInput) {
          yield {
            type: "result",
            data: { finalText: input.prompt ?? "ok" },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
        read: async (path: string) => files.get(path) ?? "",
        write: async (path: string, content: string) => {
          files.set(path, content);
        },
        exec: async () => ({ exitCode: 0, stdout: "ok\n", stderr: "" }),
        destroy: async () => {},
      };
    },
  };
}

function fakeExactProcessProvider(): AgentEnvironmentProvider {
  const environments = new Map<string, AgentExactProcessEnvironment>();
  const createInputs = new Map<string, string>();
  const files = new Map<string, Uint8Array>();
  const provider: AgentEnvironmentProvider = {
    ...fakeProvider(),
    capabilities: async () => ({
      ...(await fakeProvider().capabilities()),
      exactProcess: { egress: ["blocked", "strict"] },
    }),
    exactProcess: {
      async create(input) {
        const existing = environments.get("exact-1");
        const createIdentity = JSON.stringify(input);
        if (existing) {
          if (createInputs.get(input.idempotencyKey) !== createIdentity) {
            throw new Error("idempotency collision");
          }
          return existing;
        }
        let deleted = false;
        let spawned = false;
        let launchFingerprint: string | undefined;
        const output = "ok";
        const status = {
          pid: 41,
          idempotencyKey: undefined as string | undefined,
          running: false,
          exitCode: 0,
          termination: { kind: "exit" as const, exitCode: 0 },
        };
        const process = {
          pid: 41,
          status: async () => status,
          wait: async () => status.termination,
          kill: async () => {},
          async *stdout() {
            yield output;
          },
          async *stderr() {},
        };
        const environment: AgentExactProcessEnvironment = {
          id: "exact-1",
          provider: "fake",
          metadata: input.metadata,
          process: {
            list: async (query) =>
              deleted ||
              !spawned ||
              (query?.idempotencyKey !== undefined &&
                query.idempotencyKey !== status.idempotencyKey)
                ? []
                : [status],
            get: async (pid) => (!deleted && spawned && pid === process.pid ? process : null),
            spawn: async (launch) => {
              if (!launch.idempotencyKey || !launch.retentionMs) {
                throw new Error("missing exact process recovery fields");
              }
              const fingerprint = JSON.stringify({
                executable: launch.executable,
                args: launch.args,
                cwd: launch.cwd,
                env: launch.env,
                stdin: launch.stdin,
                timeoutMs: launch.timeoutMs,
                idempotencyKey: launch.idempotencyKey,
                retentionMs: launch.retentionMs,
              });
              if (
                launchFingerprint !== undefined &&
                launchFingerprint !== fingerprint
              ) {
                throw new Error("process idempotency collision");
              }
              launchFingerprint = fingerprint;
              status.idempotencyKey = launch.idempotencyKey;
              spawned = true;
              return process;
            },
          },
          async writeFile(path, bytes) {
            files.set(path, Uint8Array.from(bytes));
          },
          async readFile(path, options) {
            const bytes = files.get(path);
            if (!bytes) throw new Error("not found");
            if (bytes.byteLength > options.maxBytes) {
              throw new Error("file exceeds maxBytes");
            }
            return Uint8Array.from(bytes);
          },
          async destroy() {
            deleted = true;
            environments.delete(environment.id);
            files.clear();
          },
        };
        createInputs.set(input.idempotencyKey, createIdentity);
        environments.set(environment.id, environment);
        return environment;
      },
      get: async (id) => environments.get(id) ?? null,
      list: async (query) =>
        [...environments.values()].filter((environment) =>
          Object.entries(query?.metadata ?? {}).every(
            ([key, value]) => environment.metadata?.[key] === value,
          ),
        ),
    },
  };
  return provider;
}

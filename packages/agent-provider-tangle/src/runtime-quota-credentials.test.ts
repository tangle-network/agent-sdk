import { describe, expect, it } from "vitest";
import {
  createScope,
  createBudgetPool,
  createExecutorRegistry,
  InMemorySpawnJournal,
  InMemoryResultBlobStore,
  providerAsExecutor,
} from "@tangle-network/agent-runtime/kernel";
import type { PromptOptions, PromptResult } from "@tangle-network/sandbox";
import { createTangleProvider, type SandboxInstanceLike } from "./index.js";
import {
  retainedDeployment,
  retainedSessionHandle,
  RETAINED_DEPLOYMENT_DOCUMENT,
} from "./retained-control-test-helpers.js";

describe("Runtime quota re-entry with per-turn account selection", () => {
  it("keeps one logical leaf and native session while a typed quota refusal selects a distinct new execution binding", async () => {
    const profile = {
      name: "quota-continuation",
      harness: "claude-code" as const,
      model: {
        provider: "anthropic",
        default: "claude-opus-5-5",
        metadata: { credentialSource: "subscription" },
      },
      tools: {},
    };
    const bindings = new Map<string, string>();
    const grants: string[] = [];
    const turns: PromptOptions[] = [];
    const results = new Map<string, PromptResult>();
    let box: SandboxInstanceLike | undefined;
    let creates = 0;
    const provider = createTangleProvider({
      modelCredentials: async (input) => {
        const key = input.idempotencyKey!;
        let account = bindings.get(key);
        if (!account) {
          account =
            input.metadata?.nativeCredentialTurn && grants.length > 0
              ? "eligible-next"
              : "exhausted-first";
          bindings.set(key, account);
        }
        return {
          cliAuth: {
            account,
            secretEnv: account === "eligible-next" ? "ELIGIBLE_TOKEN" : "EXHAUSTED_TOKEN",
            format: "token",
          },
        };
      },
      client: {
        async fetch() {
          throw new Error("Unexpected generic transport");
        },
        async create(options = {}) {
          creates++;
          box = retainedDeployment(
            {
              id: "one-native-environment",
              metadata: options.metadata,
              createReceipt: () => ({ outcome: "created", idempotencyKeyApplied: true }),
              backend: { status: async () => ({ type: "claude-code" }) },
              async grantNativeCredential(grant) {
                grants.push(grant.cliAuth.account);
              },
              async dispatchPrompt(_message, options) {
                if (!options?.executionId || !options.sessionId)
                  throw new Error("Missing retained identity");
                turns.push(options);
                const refused = options.backend?.model?.cliAuth?.account === "exhausted-first";
                results.set(options.executionId, {
                  success: !refused,
                  status: refused ? "failed" : "success",
                  durationMs: 1,
                  executionId: options.executionId,
                  ...(refused
                    ? { error: "Subscription capacity refused", errorCode: "rate_limit_error" }
                    : {
                        response: "continued research",
                        usage: { inputTokens: 1, outputTokens: 1 },
                      }),
                });
                return {
                  sessionId: options.sessionId,
                  executionId: options.executionId,
                  runControlRef: options.runControlRef,
                  status: "running",
                  dispatched: true,
                  alreadyExisted: false,
                };
              },
              async *streamPrompt(_message, options) {
                const record = results.get(options?.executionId ?? "");
                if (!record) throw new Error("Unknown execution");
                yield {
                  id: "1",
                  type: "result",
                  data: {
                    ...record,
                    sessionId: options?.sessionId,
                    runControlRef: options?.runControlRef,
                  },
                };
                yield { id: "2", type: "done", data: { ...record, sessionId: options?.sessionId } };
              },
              session(id) {
                return {
                  ...retainedSessionHandle(id),
                  status: async () => ({
                    status: "completed",
                    sessionId: id,
                    runControlRef: turns.at(-1)?.runControlRef,
                  }),
                  result: async (options) => {
                    const result = results.get(options?.executionId ?? "");
                    if (!result) throw new Error("Unknown result");
                    return result;
                  },
                };
              },
              async delete() {},
            },
            {
              ...RETAINED_DEPLOYMENT_DOCUMENT,
              cliAuthReferences: true,
              claudeTokenContinuations: true,
            },
          );
          return box;
        },
        async get() {
          return box ?? null;
        },
        async list() {
          return box ? [box] : [];
        },
      },
    });
    const journal = new InMemorySpawnJournal();
    const blobs = new InMemoryResultBlobStore();
    await journal.beginTree("root", new Date().toISOString());
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 5000);
    try {
      const scope = createScope({
        parentId: "root",
        root: "root",
        journal,
        blobs,
        pool: createBudgetPool({ maxIterations: 2, maxTokens: 10000 }, 0),
        executors: createExecutorRegistry(),
        seams: {},
        depth: 0,
        signal: controller.signal,
      });
      const spawned = scope.spawn(
        Object.assign(
          { name: profile.name, act: async () => "unused" },
          {
            executorSpec: {
              profile,
              harness: null,
              executorFactory: providerAsExecutor(provider, {
                unavailablePause: { unavailablePauseMs: 1, maxUnavailablePauseMs: 1 },
                // Runtime releases before its turn-profile fix expose this maintained mapping hook.
                taskToTurn: (_task, exactProfile, turn) => ({
                  ...turn,
                  providerOptions: { ...turn.providerOptions, backend: { profile: exactProfile } },
                }),
              }),
            },
          },
        ),
        "continue research",
        { label: "native quota control", budget: { maxIterations: 1, maxTokens: 1000 } },
      );
      expect(spawned.ok).toBe(true);
      const settlement = await scope.next();
      expect(settlement, JSON.stringify(settlement)).toMatchObject({ kind: "done" });
      expect(creates).toBe(1);
      expect(turns).toHaveLength(2);
      expect(turns[0]?.sessionId).toBe(turns[1]?.sessionId);
      expect(turns[0]?.executionId).not.toBe(turns[1]?.executionId);
      expect(turns[0]?.turnId).not.toBe(turns[1]?.turnId);
      expect(grants).toEqual(["exhausted-first", "eligible-next"]);
      const events = await journal.loadTree("root");
      expect(events?.filter((event) => event.kind === "paused")).toHaveLength(1);
      expect(events?.filter((event) => event.kind === "settled")).toHaveLength(1);
    } finally {
      clearTimeout(deadline);
      controller.abort();
    }
  });
});

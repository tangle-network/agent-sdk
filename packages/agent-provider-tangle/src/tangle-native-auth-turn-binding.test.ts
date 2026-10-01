import { describe, expect, it } from "vitest";
import { startRetainedRun } from "@tangle-network/agent-runtime/kernel";
import type { CreateSandboxOptions, PromptOptions } from "@tangle-network/sandbox";
import type { AgentTurnInput } from "@tangle-network/agent-interface/environment-provider";
import { createTangleProvider, type SandboxInstanceLike } from "./index.js";
import {
  retainedDeployment,
  retainedSessionHandle,
  RETAINED_DEPLOYMENT_DOCUMENT,
} from "./retained-control-test-helpers.js";
import { sessionPromptRequestDigest } from "./tangle-environment-control.js";

const cliAuth = { account: "selected-research", secretEnv: "SELECTED_BUNDLE", format: "bundle" as const };
const profile = {
  name: "root", harness: "claude-code" as const,
  model: { provider: "anthropic", default: "fixture-opus", metadata: { credentialSource: "subscription" } },
  tools: { Read: true, Bash: true },
};
const turn = (): AgentTurnInput => ({
  prompt: "do real work", turnId: "turn-one",
  providerOptions: { backend: { profile, model: { authMode: "oauth" } } },
});

function setup() {
  const calls: { operation: string; options: PromptOptions | undefined }[] = [];
  const creates: CreateSandboxOptions[] = [];
  const boxes = new Map<string, SandboxInstanceLike>();
  const client = {
    async fetch(): Promise<Response> { throw new Error("capability probe must not call the network"); },
    async create(options: CreateSandboxOptions = {}) {
      creates.push(options);
      const box = retainedDeployment({
        id: `box-${creates.length}`, metadata: options.metadata,
        backend: { status: async () => ({ type: options.backend?.type ?? "claude-code" }) },
        async *streamPrompt(_message, options) { calls.push({ operation: "stream", options }); },
        async dispatchPrompt(_message, options) {
          calls.push({ operation: "dispatch", options });
          return {
            sessionId: options?.sessionId, executionId: options?.executionId,
            runControlRef: options?.runControlRef, status: "running", dispatched: true, alreadyExisted: false,
          };
        },
        session(id) {
          return {
            ...retainedSessionHandle(id),
            async prompt(_message, options) {
              calls.push({ operation: "session", options });
              return { success: true, status: "success", executionId: options?.executionId, durationMs: 1 };
            },
          };
        },
      }, { ...RETAINED_DEPLOYMENT_DOCUMENT, cliAuthReferences: true });
      boxes.set(box.id, box);
      return box;
    },
    async get(id: string) { return boxes.get(id) ?? null; },
  };
  return { client, calls, creates };
}

describe("selected native credential on Provider turns", () => {
  it("binds the selected reference before Runtime mints the initial retained control reference", async () => {
    const fixture = setup();
    const provider = createTangleProvider({ client: fixture.client, modelCredentials: { cliAuth } });
    const admissions: unknown[] = [];
    const handle = await startRetainedRun({
      provider,
      environment: { profile, idempotencyKey: "runtime:initial-root" },
      turn: { ...turn(), turnId: "initial-root:turn:0" },
      onAdmission: async (admission) => { admissions.push(admission); },
    });
    expect(fixture.calls).toHaveLength(1);
    const options = fixture.calls[0]?.options;
    expect(options?.backend?.model?.cliAuth).toEqual(cliAuth);
    expect(options?.backend?.model?.authMode).toBe("oauth");
    expect(options?.runControlRef).toEqual(handle.controlRef);
    expect(admissions).toHaveLength(3);
  });

  it.each(["stream", "dispatch", "session"] as const)(
    "preserves the create-selected reference through %s with the real H turn shape",
    async (operation) => {
      const fixture = setup();
      const provider = createTangleProvider({ client: fixture.client, modelCredentials: { cliAuth } });
      const environment = await provider.create({ profile });
      const input = turn();
      const before = structuredClone(input);
      if (operation === "stream") for await (const _event of environment.stream(input)) {}
      if (operation === "dispatch") await environment.dispatch?.(input);
      if (operation === "session") await environment.session?.("session-one").prompt(input);
      expect(fixture.calls).toHaveLength(1);
      const options = fixture.calls[0]?.options;
      expect(options?.backend).toEqual({ type: "claude-code", profile, model: { authMode: "oauth", cliAuth } });
      expect(input).toEqual(before);
      expect(fixture.creates[0]?.secrets).toEqual(["SELECTED_BUNDLE"]);
      if (operation === "dispatch") {
        const bound = { ...input, providerOptions: { backend: options?.backend } };
        expect(options?.runControlRef?.requestDigest).toBe(sessionPromptRequestDigest(
          bound, environment.provider, environment.id, options!.sessionId!, { executionId: options!.executionId! },
        ));
      }
    },
  );

  it("grants and carries the same stored binding separately for a recursive child", async () => {
    const fixture = setup();
    const provider = createTangleProvider({ client: fixture.client, modelCredentials: { cliAuth } });
    const child = { ...profile, name: "child", model: { ...profile.model, default: "fixture-sonnet" } };
    for (const current of [profile, child]) {
      const environment = await provider.create({ profile: current });
      for await (const _event of environment.stream({ ...turn(), providerOptions: { backend: { profile: current } } })) {}
    }
    expect(fixture.creates.map(options => options.secrets)).toEqual([["SELECTED_BUNDLE"], ["SELECTED_BUNDLE"]]);
    expect(fixture.calls.map(call => call.options?.backend?.model?.cliAuth)).toEqual([cliAuth, cliAuth]);
    expect(fixture.calls.map(call => call.options?.backend?.profile)).toEqual([profile, child]);
  });

  it("recovers the persisted account after the Provider process is replaced", async () => {
    const fixture = setup();
    const owner = createTangleProvider({ client: fixture.client, modelCredentials: { cliAuth } });
    const created = await owner.create({ profile });
    const replacement = createTangleProvider({ client: fixture.client, modelCredentials: {
      cliAuth: { ...cliAuth, account: "other-account", secretEnv: "OTHER_BUNDLE" },
    } });
    const recovered = await replacement.get?.(created.id);
    expect(recovered).not.toBeNull();
    for await (const _event of recovered!.stream(turn())) {}
    expect(fixture.calls[0]?.options?.backend?.model?.cliAuth).toEqual(cliAuth);
    expect(fixture.creates).toHaveLength(1);
  });

  it.each([
    { cliAuth: { ...cliAuth, account: "other" } },
    { apiKey: "fixture-private" },
    { apiKeyEnv: "OTHER_KEY" },
    { baseUrl: "https://other.example/v1" },
    { authMode: "api-key" },
    { authFiles: [{ path: ".claude/.credentials.json", content: "fixture-private" }] },
  ])("refuses replacing the bound credential (%j)", async (model) => {
    const fixture = setup();
    const environment = await createTangleProvider({ client: fixture.client, modelCredentials: { cliAuth } }).create({ profile });
    await expect(environment.dispatch?.({ ...turn(), providerOptions: { backend: { profile, model } } })).rejects.toThrow(/credential|cliAuth/);
    expect(fixture.calls).toHaveLength(0);
  });

  it("refuses changing the bound harness before dispatch", async () => {
    const fixture = setup();
    const environment = await createTangleProvider({ client: fixture.client, modelCredentials: { cliAuth } }).create({ profile });
    await expect(environment.dispatch?.({ ...turn(), providerOptions: { backend: { type: "codex" } } })).rejects.toThrow(/harness/);
    expect(fixture.calls).toHaveLength(0);
  });

  it.each(["exact", "cursor"] as const)("refuses credential substitution on %s replay", async (replay) => {
    for (const backend of [
      { type: "claude-code", model: { cliAuth: { ...cliAuth, account: "other-account" } } },
      { type: "claude-code", model: { authMode: "api-key", apiKey: "fixture-private" } },
      { type: "codex" },
    ]) {
      const fixture = setup();
      const environment = await createTangleProvider({ client: fixture.client, modelCredentials: { cliAuth } }).create({ profile });
      const admitted = await environment.dispatch?.(turn());
      if (!admitted?.controlRef) throw new Error("Expected exact admitted reference");
      const input = {
        prompt: "", controlRef: admitted.controlRef,
        ...(replay === "cursor" ? { lastEventId: "17" } : {}),
        providerOptions: { backend },
      };
      await expect((async () => {
        for await (const _event of environment.stream(input)) {}
      })()).rejects.toThrow(/credential|cliAuth|harness/);
      expect(fixture.calls).toHaveLength(1);
    }
  });

  it("leaves an exact admitted read from event zero unchanged", async () => {
    const fixture = setup();
    const environment = await createTangleProvider({ client: fixture.client, modelCredentials: { cliAuth } }).create({ profile });
    const admitted = await environment.dispatch?.(turn());
    if (!admitted?.controlRef) throw new Error("Expected exact admitted reference");
    const input = { prompt: "", controlRef: admitted.controlRef };
    for await (const _event of environment.stream(input)) {}
    expect(fixture.calls[1]?.options?.backend).toBeUndefined();
    expect(fixture.calls[1]?.options?.runControlRef).toEqual(admitted.controlRef);
  });

  it("refuses a new turn when cold recovery cannot establish its bound harness", async () => {
    const fixture = setup();
    const provider = createTangleProvider({ client: fixture.client, modelCredentials: { cliAuth } });
    const created = await provider.create({ profile });
    const box = await fixture.client.get(created.id);
    if (!box) throw new Error("Expected created box");
    box.backend = undefined;
    const recovered = await provider.get?.(created.id);
    if (!recovered) throw new Error("Expected recovered box");
    await expect(recovered.dispatch?.(turn())).rejects.toThrow(/harness/);
    expect(fixture.calls).toHaveLength(0);
  });

  it("leaves the admitted replay transport unchanged", async () => {
    const fixture = setup();
    const environment = await createTangleProvider({ client: fixture.client, modelCredentials: { cliAuth } }).create({ profile });
    const input = { ...turn(), sessionId: "existing-session", executionId: "existing-execution", lastEventId: "17" };
    for await (const _event of environment.stream(input)) {}
    expect(fixture.calls[0]?.options?.backend).toEqual({ profile, model: { authMode: "oauth" } });
    expect(fixture.calls[0]?.options?.lastEventId).toBe("17");
  });
});

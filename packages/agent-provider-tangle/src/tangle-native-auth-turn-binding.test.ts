import { describe, expect, it, vi } from "vitest";
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

function setup(rotation = false) {
  const grants: Array<{ harness: string; cliAuth: { account: string; secretEnv: string; format: string } }> = [];
  const calls: { operation: string; options: PromptOptions | undefined }[] = [];
  const creates: CreateSandboxOptions[] = [];
  const boxes = new Map<string, SandboxInstanceLike>();
  const client = {
    async fetch(): Promise<Response> { throw new Error("capability probe must not call the network"); },
    async create(options: CreateSandboxOptions = {}) {
      creates.push(options);
      const box = retainedDeployment({
        id: `box-${creates.length}`, metadata: options.metadata,
        async grantNativeCredential(grant) { grants.push(grant); },
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
      }, { ...RETAINED_DEPLOYMENT_DOCUMENT, cliAuthReferences: true, claudeTokenContinuations: rotation });
      boxes.set(box.id, box);
      return box;
    },
    async get(id: string) { return boxes.get(id) ?? null; },
  };
  return { client, calls, creates, grants };
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


describe("owner-selected native turns", () => {
  const token = (account: string) => ({ account, secretEnv: `TOKEN_${account}`, format: "token" as const });
  function owner() {
    const bindings = new Map<string, ReturnType<typeof token>>();
    const resolve = vi.fn(async (input: Readonly<import("@tangle-network/agent-interface/environment-provider").CreateAgentEnvironmentInput>) => {
      const key = input.idempotencyKey!;
      let binding = bindings.get(key);
      if (!binding) { binding = token(`ACCOUNT_${bindings.size + 1}`); bindings.set(key, binding); }
      return { cliAuth: binding };
    });
    return { bindings, resolve };
  }

  it("selects a new turn before digest minting and recovers its same binding after provider replacement", async () => {
    const f = setup(true);
    const accountOwner = owner();
    const provider = createTangleProvider({ client: f.client, modelCredentials: accountOwner.resolve });
    const env = await provider.create({ profile, idempotencyKey: "logical-pursuit" });
    const firstInput = { ...turn(), sessionId: "native-session" };
    const first = await env.dispatch!(firstInput);
    const second = await env.dispatch!({ ...firstInput, turnId: "turn-two" });
    const restarted = createTangleProvider({ client: f.client, modelCredentials: accountOwner.resolve });
    const recovered = await restarted.get!(env.id);
    const replay = await recovered!.dispatch!(firstInput);
    expect(first.controlRef).toEqual(replay.controlRef);
    expect(second.controlRef?.executionId).not.toBe(first.controlRef?.executionId);
    expect(f.grants.map(value => value.cliAuth.account)).toEqual(["ACCOUNT_2", "ACCOUNT_3", "ACCOUNT_2"]);
    expect(f.calls.map(value => value.options?.backend?.model?.cliAuth?.account))
      .toEqual(["ACCOUNT_2", "ACCOUNT_3", "ACCOUNT_2"]);
    expect(accountOwner.bindings.size).toBe(3);
    for (const [input] of accountOwner.resolve.mock.calls) {
      expect(input.profile).toEqual(profile);
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen(input.profile)).toBe(true);
    }
    expect(f.creates).toHaveLength(1);
    expect(firstInput.providerOptions?.backend).not.toHaveProperty("model.cliAuth");
    const count = accountOwner.resolve.mock.calls.length;
    for await (const _ of recovered!.stream({ controlRef: first.controlRef, lastEventId: "0" })) {}
    expect(accountOwner.resolve.mock.calls).toHaveLength(count);
    expect(f.grants).toHaveLength(3);
  });

  it("checks deployment and turn identity before contacting the owner or admitting native work", async () => {
    const f = setup(false); const accountOwner = owner();
    const env = await createTangleProvider({ client: f.client, modelCredentials: accountOwner.resolve }).create({ profile, idempotencyKey: "create" });
    await expect(env.dispatch!(turn())).rejects.toThrow("proven Claude token");
    expect(accountOwner.resolve).toHaveBeenCalledTimes(1);
    expect(f.grants).toHaveLength(0); expect(f.calls).toHaveLength(0);
    const supported = setup(true); const supportedOwner = owner();
    const ready = await createTangleProvider({ client: supported.client, modelCredentials: supportedOwner.resolve }).create({ profile, idempotencyKey: "create" });
    await expect(ready.dispatch!({ ...turn(), turnId: undefined })).rejects.toThrow("turn id");
    expect(supportedOwner.resolve).toHaveBeenCalledTimes(1);
    expect(supported.calls).toHaveLength(0);
  });

  it("holds the session prompt lock across asynchronous credential selection", async () => {
    const f = setup(true);
    const selected = token("FIRST");
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    let reached!: () => void;
    const selecting = new Promise<void>(resolve => { reached = resolve; });
    const resolve = vi.fn(async (input: Readonly<import("@tangle-network/agent-interface/environment-provider").CreateAgentEnvironmentInput>) => {
      if (input.metadata?.nativeCredentialTurn) { reached(); await pending; }
      return { cliAuth: selected };
    });
    const env = await createTangleProvider({ client: f.client, modelCredentials: resolve }).create({ profile, idempotencyKey: "create" });
    const session = env.session!("same-session");
    const first = session.prompt(turn());
    await selecting;
    await expect(session.prompt({ ...turn(), turnId: "concurrent" })).rejects.toThrow("prompt in flight");
    finish();
    await first;
    expect(f.grants).toHaveLength(1);
    expect(f.calls).toHaveLength(1);
    expect(resolve.mock.calls[1]?.[0].metadata?.nativeCredentialTurn).toMatchObject({ sessionId: "same-session", turnId: "turn-one" });
  });

  it("keeps recursive profile content and binding namespaces separate", async () => {
    const f = setup(true); const accountOwner = owner();
    const provider = createTangleProvider({ client: f.client, modelCredentials: accountOwner.resolve });
    const child = { ...profile, name: "child", tools: { Read: true }, model: { ...profile.model, default: "fixture-sonnet" } };
    for (const [index, exactProfile] of [profile, child].entries()) {
      const env = await provider.create({ profile: exactProfile, idempotencyKey: `create-${index}` });
      await env.dispatch!({ ...turn(), providerOptions: { backend: { profile: exactProfile } } });
    }
    expect(f.calls.map(call => call.options?.backend?.profile)).toEqual([profile, child]);
    expect(accountOwner.bindings.size).toBe(4);
    expect(f.grants).toHaveLength(2);
  });
});

/**
 * Shared sandbox placement: many agents in one sandbox, each still its own agent.
 *
 * The fake client below stands in for Sandbox. It records every create, every
 * turn's options and every delete, so each test reads what the platform would
 * have been asked to do.
 */

import type { CreateSandboxOptions, PromptOptions, SandboxEvent } from "@tangle-network/sandbox";
import { describe, expect, it } from "vitest";

import {
  createTangleProvider,
  type SandboxInstanceLike,
  type TangleSharedSandboxOptions,
} from "./index.js";
import { TANGLE_SHARED_SANDBOX_METADATA_KEY } from "./tangle-shared-sandboxes.js";

interface Turn {
  sandboxId: string;
  message: unknown;
  options: PromptOptions | undefined;
  kind: "stream" | "dispatch";
}

function fakeSandboxes(behavior: {
  /** Refuse a first turn that overlaps another first turn, as a cold sandbox does. */
  coldCredentialRace?: boolean;
  /** Delay before a create resolves. */
  createDelayMs?: number;
} = {}) {
  const creates: CreateSandboxOptions[] = [];
  const turns: Turn[] = [];
  const deletes: string[] = [];
  const boxes = new Map<string, SandboxInstanceLike & { status: string }>();
  let sequence = 0;
  const makeBox = (options: CreateSandboxOptions) => {
    const id = `sbx-${++sequence}`;
    let credentialInstalled = false;
    let firstTurnsInFlight = 0;
    const box: SandboxInstanceLike & { status: string } = {
      id,
      status: "running",
      ...(options.metadata ? { metadata: options.metadata as Record<string, unknown> } : {}),
      async *streamPrompt(message, promptOptions): AsyncGenerator<SandboxEvent> {
        turns.push({ sandboxId: id, message, options: promptOptions, kind: "stream" });
        if (behavior.coldCredentialRace && !credentialInstalled) {
          firstTurnsInFlight += 1;
          const contended = firstTurnsInFlight > 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          firstTurnsInFlight -= 1;
          if (contended) {
            yield {
              type: "error",
              data: { code: "MODEL_CREDENTIAL_SUPERSEDED", message: "A newer model credential is being installed; retry shortly." },
            } as SandboxEvent;
            yield { type: "done", data: {} } as SandboxEvent;
            return;
          }
          credentialInstalled = true;
        }
        yield { type: "start", data: { sandboxId: id } } as SandboxEvent;
        yield { type: "result", data: { finalText: `ran in ${id}` } } as SandboxEvent;
        yield { type: "done", data: { outcome: { type: "completed" } } } as SandboxEvent;
      },
      dispatchPrompt: async (message, promptOptions) => {
        turns.push({ sandboxId: id, message, options: promptOptions, kind: "dispatch" });
        return {
          sessionId: promptOptions?.sessionId ?? `session-${turns.length}`,
          executionId: promptOptions?.executionId ?? `execution-${turns.length}`,
          status: "running",
          alreadyExisted: false,
          dispatched: true,
        } as never;
      },
      refresh: async () => undefined,
      delete: async () => {
        deletes.push(id);
        box.status = "deleted";
      },
    };
    boxes.set(id, box);
    return box;
  };
  const client = {
    create: async (options?: CreateSandboxOptions) => {
      creates.push(options ?? {});
      if (behavior.createDelayMs) await new Promise((resolve) => setTimeout(resolve, behavior.createDelayMs));
      return makeBox(options ?? {});
    },
    get: async (id: string) => boxes.get(id) ?? null,
    list: async () => [...boxes.values()].filter((box) => box.status !== "deleted"),
  };
  return { client, creates, turns, deletes, boxes };
}

const profile = (name: string) => ({
  name,
  harness: "opencode" as const,
  model: { provider: "tangle-router", default: "deepseek/deepseek-v4.1-flash" },
  prompt: { instructions: [`You are ${name}.`] },
});

function sharedProvider(
  fake: ReturnType<typeof fakeSandboxes>,
  shared: TangleSharedSandboxOptions = { agentsPerSandbox: 3 },
) {
  return createTangleProvider({ client: fake.client, sharedSandboxes: shared });
}

async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("shared sandbox placement", () => {
  it("places seven agents in three sandboxes and runs each turn as its own agent", async () => {
    const fake = fakeSandboxes();
    const provider = sharedProvider(fake);

    const environments = await Promise.all(
      Array.from({ length: 7 }, (_, index) =>
        provider.create({
          profile: profile(`worker-${index}`),
          name: `worker-${index}`,
          metadata: { worker: index },
          egress: { mode: "open" },
        }),
      ),
    );

    expect(fake.creates).toHaveLength(3);
    for (const create of fake.creates) {
      // The sandbox carries its pool marker and none of one agent's identity.
      expect(Object.keys(create.metadata ?? {})).toEqual([TANGLE_SHARED_SANDBOX_METADATA_KEY]);
      expect(create.name).toBeUndefined();
      expect(create.egressPolicy).toEqual({ mode: "open" });
    }
    expect(new Set(environments.map((environment) => environment.id)).size).toBe(3);

    await Promise.all(
      environments.map((environment, index) =>
        drain(environment.stream({ prompt: `task ${index}` })),
      ),
    );
    expect(fake.turns).toHaveLength(7);
    for (const turn of fake.turns) {
      const worker = /task (\d)/.exec(String(turn.message))?.[1];
      expect(turn.options?.backend?.profile?.name).toBe(`worker-${worker}`);
      expect(turn.options?.backend?.type).toBe("opencode");
    }
    // Each environment reports its own agent's metadata over the shared sandbox's.
    expect(environments.map((environment) => environment.metadata?.worker)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("gives an agent whose sandbox-level input differs a sandbox of its own", async () => {
    const fake = fakeSandboxes();
    const provider = sharedProvider(fake);

    await provider.create({ profile: profile("a"), env: { TOKEN_NAME: "one" } });
    await provider.create({ profile: profile("b"), env: { TOKEN_NAME: "two" } });
    await provider.create({ profile: profile("c"), env: { TOKEN_NAME: "one" } });

    expect(fake.creates).toHaveLength(2);
    expect(fake.creates.map((create) => create.env)).toEqual([{ TOKEN_NAME: "one" }, { TOKEN_NAME: "two" }]);
  });

  it("honors a dedicated placement, and places a repository workspace alone by default", async () => {
    const fake = fakeSandboxes();
    const provider = sharedProvider(fake, {
      agentsPerSandbox: 4,
      placement: (input) =>
        typeof input.profile === "object" && input.profile.name === "untrusted" ? "dedicated" : "shared",
    });

    await provider.create({ profile: profile("reader") });
    await provider.create({ profile: profile("untrusted") });
    await provider.create({ profile: profile("writer"), workspace: { repoUrl: "https://github.com/example/repo.git" } });

    expect(fake.creates).toHaveLength(3);
    expect(fake.creates[0]?.metadata?.[TANGLE_SHARED_SANDBOX_METADATA_KEY]).toBeDefined();
    expect(fake.creates[1]?.metadata?.[TANGLE_SHARED_SANDBOX_METADATA_KEY]).toBeUndefined();
    expect(fake.creates[1]?.backend?.profile?.name).toBe("untrusted");
  });

  it("deletes a sandbox once, when its last agent is destroyed, and refills a sandbox with room", async () => {
    const fake = fakeSandboxes();
    const provider = sharedProvider(fake, { agentsPerSandbox: 2 });

    const first = await provider.create({ profile: profile("one") });
    const second = await provider.create({ profile: profile("two") });
    expect(first.id).toBe(second.id);

    await first.destroy?.();
    expect(fake.deletes).toEqual([]);

    const third = await provider.create({ profile: profile("three") });
    expect(third.id).toBe(first.id);
    expect(fake.creates).toHaveLength(1);

    await second.destroy?.();
    await second.destroy?.();
    expect(fake.deletes).toEqual([]);
    await third.destroy?.();
    expect(fake.deletes).toEqual([first.id]);

    const fourth = await provider.create({ profile: profile("four") });
    expect(fourth.id).not.toBe(first.id);
    expect(fake.creates).toHaveLength(2);
  });

  it("keeps an empty sandbox for idleMs and gives it to the next agent", async () => {
    const fake = fakeSandboxes();
    const provider = sharedProvider(fake, { agentsPerSandbox: 2, idleMs: 50 });

    const first = await provider.create({ profile: profile("one") });
    await first.destroy?.();
    const second = await provider.create({ profile: profile("two") });
    expect(second.id).toBe(first.id);
    await second.destroy?.();
    expect(fake.deletes).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fake.deletes).toEqual([first.id]);
  });

  it("admits one first turn at a time on a new sandbox, so no agent loses its turn to the credential install", async () => {
    const fake = fakeSandboxes({ coldCredentialRace: true });
    const provider = sharedProvider(fake, { agentsPerSandbox: 6 });

    const environments = await Promise.all(
      Array.from({ length: 6 }, (_, index) => provider.create({ profile: profile(`worker-${index}`) })),
    );
    const runs = await Promise.all(
      environments.map((environment, index) => drain(environment.stream({ prompt: `task ${index}` }))),
    );

    expect(fake.creates).toHaveLength(1);
    for (const events of runs) {
      expect(events.some((event) => (event as { type?: string }).type === "error")).toBe(false);
    }
  });

  it("the unshared path shows the race the gate prevents", async () => {
    const fake = fakeSandboxes({ coldCredentialRace: true });
    const box = await fake.client.create({});
    const refused = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const events: SandboxEvent[] = [];
        for await (const event of box.streamPrompt("x")) events.push(event);
        return events[0]?.type === "error";
      }),
    );
    expect(refused.filter(Boolean)).toHaveLength(3);
  });

  it("refuses a turn that would run another profile or another agent's session", async () => {
    const fake = fakeSandboxes();
    const provider = sharedProvider(fake);
    const alpha = await provider.create({ profile: profile("alpha") });
    const beta = await provider.create({ profile: profile("beta") });

    await expect(
      drain(alpha.stream({ prompt: "x", providerOptions: { backend: { profile: profile("beta") } } })),
    ).rejects.toThrow(/another profile/);

    await drain(alpha.stream({ prompt: "x", sessionId: "alpha-session" }));
    await expect(drain(beta.stream({ prompt: "y", sessionId: "alpha-session" }))).rejects.toThrow(
      /belongs to another agent/,
    );
  });

  it("lists one summary per placed agent, so a retained run proves ownership of its own lease", async () => {
    const fake = fakeSandboxes();
    const provider = sharedProvider(fake);
    const one = await provider.create({ profile: profile("one"), metadata: { retainedIdempotencyKey: "key-1" } });
    await provider.create({ profile: profile("two"), metadata: { retainedIdempotencyKey: "key-2" } });

    const owned = await provider.list!({ metadata: { retainedIdempotencyKey: "key-1" } });
    expect(owned).toEqual([
      expect.objectContaining({ id: one.id, metadata: expect.objectContaining({ retainedIdempotencyKey: "key-1" }) }),
    ]);
    await one.destroy?.();
    expect(await provider.list!({ metadata: { retainedIdempotencyKey: "key-1" } })).toEqual([]);
  });

  it("runs a turn through a handle rebuilt by id as the agent that owns the session, and never as another", async () => {
    const fake = fakeSandboxes();
    const provider = sharedProvider(fake);
    const agent = await provider.create({ profile: profile("owner") });
    await drain(agent.stream({ prompt: "first", sessionId: "owner-session" }));

    const rebuilt = await provider.get!(agent.id);
    expect(rebuilt).not.toBeNull();
    await drain(rebuilt!.stream({ prompt: "again", sessionId: "owner-session" }));
    expect(fake.turns.at(-1)?.options?.backend?.profile?.name).toBe("owner");

    await expect(drain(rebuilt!.stream({ prompt: "stray", sessionId: "unknown-session" }))).rejects.toThrow(
      /holds no agent for that session/,
    );
    // A handle that served no agent cannot end the sandbox's agents.
    const untouched = await provider.get!(agent.id);
    await expect(untouched!.destroy?.()).rejects.toThrow(/served no agent of this process/);
    expect(fake.deletes).toEqual([]);
  });

  it("releases each retained agent through the handle Runtime rebuilds for it, and deletes the sandbox after the last", async () => {
    const fake = fakeSandboxes();
    const provider = sharedProvider(fake);
    const agents = await Promise.all(
      ["a", "b"].map((name) =>
        provider.create({ profile: profile(name), metadata: { retainedIdempotencyKey: `key-${name}` } }),
      ),
    );
    expect(agents[0]!.id).toBe(agents[1]!.id);
    for (const [index, agent] of agents.entries()) {
      await drain(agent.stream({ prompt: `task ${index}`, sessionId: `retained-${index}` }));
    }
    expect(fake.turns.map((turn) => turn.options?.backend?.profile?.name)).toEqual(["a", "b"]);

    // Runtime's retained path: rebuild by id, bind the exact session, and destroy through that handle.
    const first = await provider.get!(agents[0]!.id);
    first!.session!("retained-0");
    await first!.destroy?.();
    expect(fake.deletes).toEqual([]);
    expect(await provider.list!({ metadata: { retainedIdempotencyKey: "key-a" } })).toEqual([]);
    expect(await provider.list!({ metadata: { retainedIdempotencyKey: "key-b" } })).toHaveLength(1);

    const second = await provider.get!(agents[1]!.id);
    second!.session!("retained-1");
    await second!.destroy?.();
    expect(fake.deletes).toEqual([agents[0]!.id]);
  });

  it("stops placing agents in a sandbox that is no longer running", async () => {
    const fake = fakeSandboxes();
    const provider = sharedProvider(fake);
    const first = await provider.create({ profile: profile("one") });
    await drain(first.stream({ prompt: "warm" }));
    fake.boxes.get(first.id)!.status = "stopped";

    const second = await provider.create({ profile: profile("two") });
    expect(second.id).not.toBe(first.id);
    expect(fake.creates).toHaveLength(2);
  });

  it("fails every waiting agent when the shared sandbox cannot be created, and retries on the next create", async () => {
    const fake = fakeSandboxes();
    let fail = true;
    const create = fake.client.create;
    fake.client.create = async (options) => {
      if (fail) throw new Error("capacity exhausted");
      return create(options);
    };
    const provider = sharedProvider(fake);

    const attempts = await Promise.allSettled(
      Array.from({ length: 3 }, (_, index) => provider.create({ profile: profile(`w${index}`) })),
    );
    expect(attempts.every((attempt) => attempt.status === "rejected")).toBe(true);

    fail = false;
    await provider.create({ profile: profile("after") });
    expect(fake.creates).toHaveLength(1);
  });

  it("refuses options it cannot honor", () => {
    const fake = fakeSandboxes();
    expect(() => sharedProvider(fake, { agentsPerSandbox: 0 })).toThrow(/positive integer/);
    expect(() =>
      createTangleProvider({
        client: fake.client,
        sharedSandboxes: { agentsPerSandbox: 2 },
        mapCreateInput: () => ({}),
      }),
    ).toThrow(/cannot be combined with mapCreateInput/);
    expect(() => sharedProvider(fake, { agentsPerSandbox: 2, slots: 3 } as never)).toThrow(/not supported/);
  });
});

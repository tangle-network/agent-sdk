import type { StreamEvent } from "@tangle-network/agent-interface";
import { afterEach, describe, expect, it } from "vitest";
import { InteractionBroker } from "../../src/interactions/broker.js";
import { InteractionHttpBridge } from "../../src/interactions/http-bridge.js";

const binding = {
  runId: "run-1",
  provider: "test-provider",
  environmentId: "environment-1",
  sessionId: "session-1",
  executionId: "execution-1",
};

type InteractionEvent = Extract<StreamEvent, { type: "interaction" }>;
let activeBridge: InteractionHttpBridge | undefined;

afterEach(async () => {
  await activeBridge?.stop();
  activeBridge = undefined;
});

async function waitForInteraction(
  events: StreamEvent[],
): Promise<InteractionEvent> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const event = events.find(
      (candidate): candidate is InteractionEvent =>
        candidate.type === "interaction",
    );
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Interaction event did not arrive");
}

async function start(events: StreamEvent[]) {
  const broker = new InteractionBroker();
  activeBridge = new InteractionHttpBridge(broker, {
    sessionId: "session-1",
    binding,
    emit: (event) => events.push(event),
  });
  await activeBridge.start();
  return { bridge: activeBridge, broker };
}

function post(
  bridge: InteractionHttpBridge,
  path: string,
  body: unknown,
  authorized = true,
) {
  return fetch(`${bridge.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorized
        ? { Authorization: `Bearer ${bridge.token}` }
        : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("InteractionHttpBridge", () => {
  it("requires its ephemeral bearer token", async () => {
    const { bridge } = await start([]);
    expect((await post(bridge, "/permission", {}, false)).status).toBe(401);
  });

  it("round-trips a permission through real HTTP", async () => {
    const events: StreamEvent[] = [];
    const { bridge, broker } = await start(events);
    const responsePromise = post(bridge, "/permission", {
      tool_name: "Bash",
      input: { command: "pnpm test" },
    });
    const event = await waitForInteraction(events);
    expect(event.request.kind).toBe("permission");
    broker.respond({
      id: event.request.id,
      outcome: "accepted",
      data: { grant: ["allow_once"] },
    });
    expect(await (await responsePromise).json()).toEqual({ allowed: true });
  });

  it("round-trips a question through real HTTP", async () => {
    const events: StreamEvent[] = [];
    const { bridge, broker } = await start(events);
    const responsePromise = post(bridge, "/question", {
      questions: [{ question: "Which database?" }],
    });
    const event = await waitForInteraction(events);
    expect(event.request.kind).toBe("question");
    broker.respondQuestion({
      id: event.request.id,
      outcome: "accepted",
      data: { q0: "Postgres" },
    });
    expect(await (await responsePromise).json()).toEqual({
      answers: [["Postgres"]],
    });
  });

  it("rejects malformed input and unknown routes", async () => {
    const { bridge } = await start([]);
    expect(
      (await post(bridge, "/permission", { tool_name: "" })).status,
    ).toBe(400);
    expect(
      (await post(bridge, "/question", { questions: [] })).status,
    ).toBe(400);
    expect((await post(bridge, "/unknown", {})).status).toBe(404);
  });

  it("fails pending work closed when the bridge stops", async () => {
    const events: StreamEvent[] = [];
    const { bridge } = await start(events);
    const responsePromise = post(bridge, "/permission", {
      tool_name: "Write",
    });
    await waitForInteraction(events);
    await bridge.stop();
    activeBridge = undefined;
    const settled = responsePromise
      .then((response) => response.json())
      .catch(() => ({ allowed: false }));
    await expect(settled).resolves.toEqual({ allowed: false });
  });
});

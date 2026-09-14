import { readFileSync } from "node:fs";
import type { SandboxEvent } from "@tangle-network/sandbox";
import {
  AgentTurnResultSchema,
  type AgentEnvironmentEvent,
} from "@tangle-network/agent-interface/environment-provider";
import type { AgentExactRunControlRef, TokenUsage } from "@tangle-network/agent-interface";
import { describe, expect, it } from "vitest";
import { createTangleProvider } from "./index.js";
import { retainedDeployment, retainedSessionHandle } from "./retained-control-test-helpers.js";

/**
 * Frames recorded from production Sandbox executions of the OpenCode harness
 * (discovery-lab run `mech-interp-foundations-astra-b-20260912a`, GLM-5.3).
 * `test/fixtures/README.md` names the archives and what was shortened.
 */
function recording(name: string): SandboxEvent[] {
  const parsed = JSON.parse(
    readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8"),
  ) as { events: SandboxEvent[] };
  return parsed.events;
}

/** Child s19: every frame of one execution, in delivery order. */
const s19 = recording("opencode-glm-execution-events.json");
/** Child s0: its 43 step_finish frames, then result and done. */
const s0 = recording("opencode-glm-step-usage-s0.json");

const s19Receipt: TokenUsage = {
  inputTokens: 35_510,
  outputTokens: 11_565,
  totalTokens: 47_075,
  cacheReadInputTokens: 25_024,
  cacheCreationInputTokens: 0,
  reasoningTokens: 7_636,
};

async function collect(values: AsyncIterable<AgentEnvironmentEvent>): Promise<AgentEnvironmentEvent[]> {
  const collected: AgentEnvironmentEvent[] = [];
  for await (const value of values) collected.push(value);
  return collected;
}

function data(event: SandboxEvent): Record<string, unknown> {
  return event.data as Record<string, unknown>;
}

function isStepFinish(event: SandboxEvent | AgentEnvironmentEvent): boolean {
  const frame = event.data as { event?: { type?: unknown } };
  return event.type === "raw" && frame.event?.type === "step_finish";
}

/** Replace the step part's token counts on a copy of a recorded frame. */
function withStepTokens(event: SandboxEvent, tokens: unknown, id = event.id): SandboxEvent {
  const frame = structuredClone(event) as SandboxEvent & {
    data: { event: { part: Record<string, unknown> } };
  };
  frame.data.event.part.tokens = tokens;
  return { ...frame, ...(id === undefined ? {} : { id }) };
}

/**
 * The same frame as the live run stream writes it. The replay buffer keeps the
 * sidecar's `{ type: "raw", backend, event }` envelope, while the live stream
 * writes only `event` as the frame data; the SDK stamps `sandboxId` on both.
 */
function liveFrame(frame: SandboxEvent): SandboxEvent {
  if (frame.type !== "raw") return frame;
  const envelope = data(frame) as { event: Record<string, unknown>; sandboxId: string };
  return { ...frame, data: { ...envelope.event, sandboxId: envelope.sandboxId } };
}

async function streamed(frames: readonly SandboxEvent[]): Promise<AgentEnvironmentEvent[]> {
  const provider = createTangleProvider({
    client: {
      async create() {
        return {
          id: "sandbox-recorded",
          status: "running",
          async *streamPrompt() {
            for (const frame of frames) yield structuredClone(frame);
          },
        };
      },
    },
  });
  const environment = await provider.create({ profile: { name: "recorded" } });
  return collect(environment.stream({ prompt: "recorded execution" }));
}

/**
 * The retained exact-execution lane the runtime observes a detached child on:
 * `session.events()` replays the named execution through `streamPrompt`.
 */
async function retainedReplay(
  frames: readonly SandboxEvent[],
  options: { since?: string } = {},
): Promise<AgentEnvironmentEvent[]> {
  const started = frames.find((frame) => frame.type === "execution.started");
  const controlRef = data(started!).runControlRef as AgentExactRunControlRef;
  const box = retainedDeployment({
    id: controlRef.environmentId,
    async *streamPrompt(_prompt, promptOptions) {
      expect(promptOptions).toMatchObject({ executionId: controlRef.executionId });
      const after = Number(promptOptions?.lastEventId ?? "0");
      for (const frame of frames) {
        if (Number(frame.id) > after) yield structuredClone(frame);
      }
    },
    session: () => retainedSessionHandle(controlRef.sessionId),
  });
  const provider = createTangleProvider({ client: { async create() { return box; } } });
  const environment = await provider.create({ profile: { name: "recorded" } });
  const session = environment.session!(controlRef.sessionId, { controlRef });
  return collect(session.events(options.since === undefined ? {} : { since: options.since }));
}

function expectMonotone(usages: readonly TokenUsage[]): void {
  for (let index = 1; index < usages.length; index += 1) {
    const previous = usages[index - 1]!;
    const current = usages[index]!;
    for (const key of Object.keys(previous) as (keyof TokenUsage)[]) {
      expect(current[key], `${key} at step ${index + 1}`).toBeGreaterThanOrEqual(previous[key]!);
    }
  }
}

describe("in-flight OpenCode step usage", () => {
  it("carries the execution's cumulative usage on each recorded step, ending at the terminal receipt", async () => {
    for (const events of [await retainedReplay(s19), await streamed(s19)]) {
      expect(events).toHaveLength(s19.length);
      const steps = events.filter(isStepFinish);
      expect(steps.map((event) => event.id)).toEqual(["15", "40", "59"]);
      for (const step of steps) expect(step.usageMode).toBe("cumulative");
      // Step one: input 582, output 35, reasoning 50, cache read 6720, cache write 0.
      expect(steps[0]!.usage).toEqual({
        inputTokens: 7_302,
        outputTokens: 85,
        totalTokens: 7_387,
        cacheReadInputTokens: 6_720,
        cacheCreationInputTokens: 0,
        reasoningTokens: 50,
      });
      expectMonotone(steps.map((step) => step.usage!));
      // The sidecar's own aggregate is the oracle: the last step already equals it.
      expect(steps.at(-1)!.usage).toEqual(s19Receipt);
      const terminal = events.filter((event) => event.type === "result" || event.type === "done");
      expect(terminal.map((event) => [event.type, event.usage, event.usageMode])).toEqual([
        ["result", s19Receipt, "cumulative"],
        ["done", s19Receipt, "cumulative"],
      ]);
      // Only step frames gain usage, and every frame keeps its recorded payload.
      expect(events.filter((event) => event.usage !== undefined)).toHaveLength(5);
      events.forEach((event, index) => expect(event.providerEvent).toEqual(s19[index]));
      expect(() => AgentTurnResultSchema.parse({ text: "", success: true, events })).not.toThrow();
    }
  });

  it("reads the live stream's unwrapped step frames the same way", async () => {
    const live = await streamed(s19.map(liveFrame));
    const replayed = await streamed(s19);
    expect(live.filter((event) => event.usage !== undefined).map((event) => [event.id, event.usage, event.usageMode]))
      .toEqual(replayed.filter((event) => event.usage !== undefined).map((event) => [event.id, event.usage, event.usageMode]));
    expect(live.filter((event) => event.usageMode === "cumulative")).toHaveLength(5);
  });

  it("makes a long execution's spend visible long before its receipt", async () => {
    const events = await streamed(s0);
    const steps = events.filter(isStepFinish);
    expect(steps).toHaveLength(43);
    for (const step of steps) expect(step.usageMode).toBe("cumulative");
    expectMonotone(steps.map((step) => step.usage!));
    const receipt = events.find((event) => event.type === "result")!.usage!;
    expect(receipt).toMatchObject({ inputTokens: 1_871_225, outputTokens: 46_902 });
    expect(steps.at(-1)!.usage).toEqual(receipt);
    // Issue #324: this child held an 800,000-token reservation and every event
    // before its receipt reported zero. Step 26 of 43 already crosses it.
    const crossing = steps.findIndex(
      (step) => step.usage!.inputTokens + step.usage!.outputTokens > 800_000,
    );
    expect(crossing + 1).toBe(26);
    expect(steps[crossing]!.usage).toMatchObject({ inputTokens: 834_001, outputTokens: 18_534 });
  });

  it("counts a step once when a reconnect delivers it again", async () => {
    const firstStep = s19.find(isStepFinish)!;
    // A reconnect inside one stream replays the buffered envelope of a step the
    // live stream already delivered unwrapped.
    const frames = s19.flatMap((frame) =>
      frame === firstStep ? [liveFrame(frame), frame, { ...structuredClone(frame), id: "15-redelivered" }] : [frame],
    );
    const events = await streamed(frames);
    const steps = events.filter((event) => event.type === "raw" && event.id?.startsWith("15"));
    expect(steps.map((step) => [step.id, step.usage?.inputTokens])).toEqual([
      ["15", 7_302],
      ["15", undefined],
      ["15-redelivered", undefined],
    ]);
    expect(events.filter(isStepFinish).at(-1)!.usage).toEqual(s19Receipt);
  });

  it("claims no cumulative total on a replay that starts after the execution's first frame", async () => {
    const events = await retainedReplay(s19, { since: "20" });
    expect(events[0]?.id).toBe("21");
    const steps = events.filter(isStepFinish);
    expect(steps.map((step) => step.id)).toEqual(["40", "59"]);
    for (const step of steps) {
      expect(step.usage).toBeUndefined();
      expect(step.usageMode).toBeUndefined();
    }
    expect(events.find((event) => event.type === "result")?.usage).toEqual(s19Receipt);
  });

  it("passes a terminal receipt below the streamed steps through unchanged", async () => {
    const lowered = { ...s19Receipt, inputTokens: 30_000 };
    const frames = s19.map((frame) =>
      frame.type === "result" || frame.type === "done"
        ? { ...frame, data: { ...data(frame), tokenUsage: lowered } }
        : frame,
    );
    const events = await streamed(frames);
    const steps = events.filter(isStepFinish);
    // The steps keep what they measured and the receipt keeps what it reports.
    // Neither is rewritten to agree, so a cumulative fold sees the total fall.
    expect(steps.at(-1)!.usage!.inputTokens).toBe(35_510);
    const result = events.find((event) => event.type === "result")!;
    expect(result.usage).toEqual(lowered);
    expect(result.usageMode).toBe("cumulative");
  });

  it("refuses a step whose token counts cannot be read", async () => {
    const firstStep = s19.find(isStepFinish)!;
    for (const tokens of [
      { input: -1, output: 35 },
      { input: 582, output: 1.5 },
      { input: 582, output: 35, cache: { read: "6720" } },
      "7387",
    ]) {
      const frames = s19.map((frame) => (frame === firstStep ? withStepTokens(frame, tokens) : frame));
      await expect(streamed(frames)).rejects.toThrow(/Tangle OpenCode step/);
    }
  });

  it("claims no total after a step reports incomplete counts", async () => {
    const [firstStep, secondStep] = s19.filter(isStepFinish);
    const frames = s19.map((frame) =>
      frame === secondStep ? withStepTokens(frame, { input: 9_000, cache: { read: 1 } }) : frame,
    );
    const events = await streamed(frames);
    expect(events.filter(isStepFinish).map((step) => [step.id, step.usage?.inputTokens, step.usageMode])).toEqual([
      [firstStep!.id, 7_302, "cumulative"],
      ["40", undefined, undefined],
      ["59", undefined, undefined],
    ]);
    expect(events.find((event) => event.type === "result")?.usage).toEqual(s19Receipt);
  });

  it("leaves a step frame without token counts, and other harnesses' raw frames, without usage", async () => {
    const firstStep = s19.find(isStepFinish)!;
    const withoutTokens = structuredClone(firstStep) as SandboxEvent & {
      data: { event: { part: Record<string, unknown> } };
    };
    delete withoutTokens.data.event.part.tokens;
    const foreign = {
      ...structuredClone(firstStep),
      id: "15-codex",
      data: { ...structuredClone(data(firstStep)), backend: "codex" },
    };
    const events = await streamed([withoutTokens, foreign]);
    expect(events.map((event) => event.usage)).toEqual([undefined, undefined]);
  });
});

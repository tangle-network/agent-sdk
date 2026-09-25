/**
 * Shared sandbox placement against production Tangle Sandbox.
 *
 * Runs only with TANGLE_API_KEY and TANGLE_LIVE=1. It creates real sandboxes, runs real OpenCode
 * turns, measures the sandboxes' memory, and deletes everything it created.
 */

import { Sandbox } from "@tangle-network/sandbox";
import { afterAll, describe, expect, it } from "vitest";

import { createTangleProvider } from "./index.js";

const apiKey = process.env.TANGLE_API_KEY;
const live = apiKey !== undefined && apiKey.length > 0 && process.env.TANGLE_LIVE === "1";
const baseUrl = process.env.TANGLE_SANDBOX_URL ?? "https://sandbox.tangle.tools";
const agents = Number(process.env.TANGLE_LIVE_AGENTS ?? 4);
const model = process.env.TANGLE_LIVE_MODEL ?? "deepseek/deepseek-v4.1-flash";
const runTag = `sdk-shared-live-${Date.now()}`;

const profile = (name: string, word: string) => ({
  name,
  harness: "opencode" as const,
  model: { provider: "tangle-router", default: model },
  prompt: {
    instructions: [
      `Your code word is ${word}.`,
      "When asked for your code word, reply with the code word only.",
    ],
  },
});

/** The model's words from a turn's events: only text-bearing fields, never an echoed profile. */
const raw: string[] = [];
async function answer(stream: AsyncIterable<unknown>): Promise<string> {
  const texts: string[] = [];
  const collect = (value: unknown, key?: string): void => {
    if (typeof value === "string") {
      if (key !== undefined && ["text", "finalText", "delta", "content", "output"].includes(key)) {
        texts.push(value);
      }
      return;
    }
    if (Array.isArray(value)) for (const item of value) collect(item, key);
    else if (value !== null && typeof value === "object") {
      for (const [name, item] of Object.entries(value)) {
        if (name === "profile" || name === "instructions") continue;
        collect(item, name);
      }
    }
  };
  const types: string[] = [];
  for await (const event of stream) {
    collect(event);
    types.push(String((event as { type?: unknown }).type));
    raw.push(JSON.stringify(event).slice(0, 600));
  }
  return texts.join(" ");
}

/** Memory the box's cgroup charges now and at its peak, in MiB. */
async function memory(client: Sandbox, id: string) {
  const box = await client.get(id);
  if (box === null) throw new Error(`sandbox ${id} is gone`);
  const result = await box.exec(
    "cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak 2>/dev/null; " +
      "cat /sys/fs/cgroup/memory.max 2>/dev/null; pgrep -c -f opencode || true",
  );
  const [current, peak, max, opencode] = result.stdout.trim().split(/\s+/u);
  const mib = (value: string | undefined) =>
    value === undefined || !/^\d+$/u.test(value) ? null : Math.round(Number(value) / 1048576);
  return {
    currentMiB: mib(current),
    peakMiB: mib(peak),
    limitMiB: mib(max),
    opencodeProcesses: Number(opencode ?? 0),
  };
}

describe.skipIf(!live)("shared sandbox placement on production Tangle", () => {
  const client = new Sandbox({ apiKey: apiKey ?? "", baseUrl });
  const destroyers: Array<() => Promise<unknown>> = [];

  afterAll(async () => {
    await Promise.allSettled(destroyers.map((destroy) => destroy()));
    const left = (await client.list()).filter(
      (box) => (box.metadata as Record<string, unknown> | undefined)?.liveRun === runTag,
    );
    await Promise.allSettled(left.map((box) => box.delete()));
  }, 300_000);

  it("keeps each agent's instructions apart and measures memory against dedicated sandboxes", async () => {
    const words = Array.from({ length: agents }, (_, index) => `WORD${index}${runTag.slice(-5)}`);
    const shared = createTangleProvider({
      client,
      sharedSandboxes: { agentsPerSandbox: agents },
    });
    const dedicated = createTangleProvider({ client });

    const started = Date.now();
    const placed = await Promise.all(
      words.map((word, index) =>
        shared.create({
          profile: profile(`shared-${index}`, word),
          metadata: { liveRun: runTag },
        }),
      ),
    );
    const sharedCreateMs = Date.now() - started;
    for (const environment of placed) destroyers.push(() => environment.destroy?.() ?? Promise.resolve());
    const boxIds = [...new Set(placed.map((environment) => environment.id))];
    const idle = await memory(client, boxIds[0]!);

    const answers = await Promise.all(
      placed.map((environment) =>
        answer(environment.stream({ prompt: "What is your code word?" })),
      ),
    );
    const own = answers.map((text, index) => text.includes(words[index]!));
    const foreign = answers.map((text, index) =>
      words.filter((word, other) => other !== index && text.includes(word)).length,
    );
    const sharedAfter = await memory(client, boxIds[0]!);

    const dedicatedStarted = Date.now();
    const single = await dedicated.create({
      profile: profile("dedicated-0", "SOLOWORD"),
      metadata: { liveRun: runTag },
    });
    const dedicatedCreateMs = Date.now() - dedicatedStarted;
    destroyers.push(() => single.destroy?.() ?? Promise.resolve());
    const dedicatedIdle = await memory(client, single.id);
    const soloAnswer = await answer(single.stream({ prompt: "What is your code word?" }));
    const dedicatedAfter = await memory(client, single.id);

    const report = {
      agents,
      model,
      sandboxes: boxIds.length,
      sharedCreateMs,
      dedicatedCreateMs,
      ownAnswers: own.filter(Boolean).length,
      foreignWordsSeen: foreign.reduce((sum, count) => sum + count, 0),
      soloAnswered: soloAnswer.includes("SOLOWORD"),
      sharedIdle: idle,
      sharedAfterTurns: sharedAfter,
      dedicatedIdle,
      dedicatedAfterTurn: dedicatedAfter,
    };
    console.log(`SHARED_PLACEMENT_LIVE ${JSON.stringify(report)}`);
    if (process.env.TANGLE_LIVE_REPORT) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(process.env.TANGLE_LIVE_REPORT, `${JSON.stringify({ ...report, answers, raw: raw.slice(0, 40) })}\n`);
    }

    expect(boxIds).toHaveLength(1);
    expect(report.soloAnswered).toBe(true);
    expect(report.ownAnswers).toBe(agents);
    expect(report.foreignWordsSeen).toBe(0);
  }, 900_000);
});

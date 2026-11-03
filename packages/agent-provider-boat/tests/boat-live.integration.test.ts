import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { formatLiveReport, runLiveProfileConformance } from "@tangle-network/agent-provider-testkit";
import { describe, expect, it } from "vitest";
import { createBoatProvider } from "../src/index.js";
import type { AgentEnvironment } from "@tangle-network/agent-interface/environment-provider";

const model = process.env.LIVE_CONFORMANCE_MODEL ?? "glm-5.3";

describe("live profile conformance on Boat", () => {
  it("meets SPEC.md in a Boat sandbox on the Router", { timeout: 3_600_000 }, async (context) => {
    const routerKey = process.env.TANGLE_API_KEY ?? "";
    const report = await runLiveProfileConformance({
      name: "boat",
      credentials: ["BOAT_API_KEY", "TANGLE_API_KEY"],
      harness: "claude-code",
      model,
      secretValues: [routerKey, process.env.BOAT_API_KEY ?? ""].filter(Boolean),
      createProvider: () => createBoatProvider({ router: { key: routerKey } }),
      log: (line) => process.stderr.write(`${line}\n`),
    });
    const artifact = process.env.LIVE_CONFORMANCE_ARTIFACT;
    if (artifact !== undefined && artifact !== "") writeFileSync(artifact, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${formatLiveReport(report)}\n`);
    if (report.skipped !== undefined) context.skip(report.skipped);
    expect(report.results.filter((result) => result.status === "fail")).toEqual([]);
  });

  it("checkpoints state and forks a new Boat sandbox that carries it", { timeout: 3_600_000 }, async (context) => {
    const routerKey = process.env.TANGLE_API_KEY ?? "";
    const apiKey = process.env.BOAT_API_KEY ?? "";
    if (apiKey === "" || routerKey === "") context.skip("BOAT_API_KEY and TANGLE_API_KEY are required");
    const provider = createBoatProvider({ apiKey, router: { key: routerKey } });
    const marker = `boat-ckpt-${randomUUID()}`;
    let source: AgentEnvironment | undefined;
    let forked: AgentEnvironment | undefined;
    try {
      source = await provider.create({ profile: { name: "boat-checkpoint-proof", harness: "claude-code" } });
      const written = await source.exec!(`printf %s ${marker} > /home/node/workspace/marker.txt`);
      expect(written.exitCode).toBe(0);
      const checkpoint = await source.checkpoint!({ name: `ckpt-${marker}` });
      expect(checkpoint.provider).toBe("boat");
      forked = await source.fork!(checkpoint, { name: `fork-${marker}` });
      expect(forked.id).not.toBe(source.id);
      const read = await forked.exec!("cat /home/node/workspace/marker.txt");
      expect(read.stdout).toBe(marker);
    } finally {
      await forked?.destroy?.().catch(() => undefined);
      await source?.destroy?.().catch(() => undefined);
    }
  });
});

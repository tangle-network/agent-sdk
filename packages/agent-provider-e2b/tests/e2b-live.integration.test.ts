import { writeFileSync } from "node:fs";
import { formatLiveReport, runLiveProfileConformance } from "@tangle-network/agent-provider-testkit";
import { describe, expect, it } from "vitest";
import { createE2BProvider } from "../src/index.js";

const model = process.env.LIVE_CONFORMANCE_MODEL ?? "glm-5.3";

describe("live profile conformance on E2B", () => {
  it("meets SPEC.md in an E2B sandbox from the box template on the Router", { timeout: 3_600_000 }, async (context) => {
    const apiKey = process.env.E2B_API_KEY ?? "";
    const routerKey = process.env.TANGLE_API_KEY ?? "";
    const report = await runLiveProfileConformance({
      name: "e2b",
      credentials: ["E2B_API_KEY", "TANGLE_API_KEY"],
      harness: "claude-code",
      model,
      secretValues: [apiKey, routerKey],
      createProvider: () =>
        createE2BProvider({
          apiKey,
          router: { key: routerKey },
          ...(process.env.E2B_TEMPLATE ? { template: process.env.E2B_TEMPLATE } : {}),
        }),
      log: (line) => process.stderr.write(`${line}\n`),
    });
    const artifact = process.env.LIVE_CONFORMANCE_ARTIFACT;
    if (artifact !== undefined && artifact !== "") writeFileSync(artifact, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${formatLiveReport(report)}\n`);
    if (report.skipped !== undefined) context.skip(report.skipped);
    expect(report.results.filter((result) => result.status === "fail")).toEqual([]);
  });
});

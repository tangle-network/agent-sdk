import { writeFileSync } from "node:fs";
import { formatLiveReport, runLiveProfileConformance } from "@tangle-network/agent-provider-testkit";
import { describe, expect, it } from "vitest";
import { createDaytonaProvider } from "../src/index.js";

const model = process.env.LIVE_CONFORMANCE_MODEL ?? "glm-5.3";

describe("live profile conformance on Daytona", () => {
  it("meets SPEC.md in a Daytona box on the Router", { timeout: 3_600_000 }, async (context) => {
    const routerKey = process.env.TANGLE_API_KEY ?? "";
    const report = await runLiveProfileConformance({
      name: "daytona",
      credentials: ["DAYTONA_API_KEY", "TANGLE_API_KEY"],
      harness: "claude-code",
      model,
      secretValues: [routerKey, process.env.DAYTONA_API_KEY ?? ""].filter(Boolean),
      createProvider: () =>
        createDaytonaProvider({
          router: { key: routerKey },
          ...(process.env.DAYTONA_SNAPSHOT ? { snapshot: process.env.DAYTONA_SNAPSHOT } : {}),
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

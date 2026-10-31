import { writeFileSync } from "node:fs";
import { formatLiveReport, runLiveProfileConformance } from "@tangle-network/agent-provider-testkit";
import { describe, expect, it } from "vitest";
import { createBridgeSandboxProvider } from "../src/sandbox/index.js";
import { dockerBoxVendor } from "./docker-box-vendor.js";

const model = process.env.LIVE_CONFORMANCE_MODEL ?? "glm-5.3";

describe("live profile conformance through a vendor sandbox running CLI Bridge", () => {
  it("meets SPEC.md in a Docker box on the Router", { timeout: 3_600_000 }, async (context) => {
    const routerKey = process.env.TANGLE_API_KEY ?? "";
    const report = await runLiveProfileConformance({
      name: "bridge-docker-box",
      credentials: ["TANGLE_API_KEY", "CLI_BRIDGE_BOX_IMAGE"],
      harness: "claude-code",
      model,
      secretValues: [routerKey],
      createProvider: () =>
        createBridgeSandboxProvider({
          vendor: dockerBoxVendor(process.env.CLI_BRIDGE_BOX_IMAGE ?? ""),
          router: { key: routerKey },
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

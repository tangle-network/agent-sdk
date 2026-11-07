import { writeFileSync } from "node:fs";
import type { HarnessType } from "@tangle-network/agent-interface";
import { formatLiveReport, runLiveProfileConformance } from "@tangle-network/agent-provider-testkit";
import { describe, expect, it } from "vitest";
import { BOX_HARNESSES, createBridgeSandboxProvider } from "../src/sandbox/index.js";
import { dockerBoxVendor } from "./docker-box-vendor.js";

const model = process.env.LIVE_CONFORMANCE_MODEL ?? "zai/glm-5.3";
// Every harness the box carries; LIVE_CONFORMANCE_HARNESSES narrows the run to a comma-separated subset.
const selected = process.env.LIVE_CONFORMANCE_HARNESSES?.split(",").map((name) => name.trim()).filter(Boolean);
const harnesses = (Object.keys(BOX_HARNESSES) as HarnessType[]).filter((harness) => selected === undefined || selected.includes(harness));
const unknown = selected?.filter((harness) => !(harness in BOX_HARNESSES)) ?? [];

describe("live profile conformance through a vendor sandbox running CLI Bridge", () => {
  it("selects only harnesses the box carries", () => {
    expect(unknown).toEqual([]);
  });

  it.for(harnesses)("meets SPEC.md with %s in a Docker box on the Router", { timeout: 3_600_000 }, async (harness, context) => {
    const routerKey = process.env.TANGLE_API_KEY ?? "";
    const report = await runLiveProfileConformance({
      name: `bridge-docker-box-${harness}`,
      credentials: ["TANGLE_API_KEY", "CLI_BRIDGE_BOX_IMAGE"],
      harness,
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
    if (artifact !== undefined && artifact !== "") writeFileSync(artifact.replace("{harness}", harness), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${formatLiveReport(report)}\n`);
    if (report.skipped !== undefined) context.skip(report.skipped);
    expect(report.results.filter((result) => result.status === "fail")).toEqual([]);
  });
});

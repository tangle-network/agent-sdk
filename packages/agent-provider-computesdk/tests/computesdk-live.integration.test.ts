import { writeFileSync } from "node:fs";
import { docker } from "@computesdk/docker";
import { e2b } from "@computesdk/e2b";
import { BOX_WORKSPACE_DIR, BRIDGE_PORT } from "@tangle-network/agent-provider-cli-bridge/sandbox";
import { formatLiveReport, runLiveProfileConformance, type LiveProfileConformanceOptions } from "@tangle-network/agent-provider-testkit";
import { compute } from "computesdk";
import { describe, expect, it } from "vitest";
import { createComputeSdkProvider } from "../src/index.js";

const model = process.env.LIVE_CONFORMANCE_MODEL ?? "glm-5.3";
const routerKey = process.env.TANGLE_API_KEY ?? "";

async function conform(name: string, options: Pick<LiveProfileConformanceOptions, "credentials" | "secretValues" | "createProvider">, skip: (reason: string) => void) {
  const report = await runLiveProfileConformance({ name, harness: "claude-code", model, log: (line) => process.stderr.write(`${line}\n`), ...options });
  const artifact = process.env.LIVE_CONFORMANCE_ARTIFACT;
  if (artifact !== undefined && artifact !== "") writeFileSync(`${artifact}.${name}.json`, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${formatLiveReport(report)}\n`);
  if (report.skipped !== undefined) skip(report.skipped);
  expect(report.results.filter((result) => result.status === "fail")).toEqual([]);
}

describe("live profile conformance through computesdk", () => {
  it("meets SPEC.md on the e2b backing provider from the box template", { timeout: 3_600_000 }, async (context) => {
    const apiKey = process.env.E2B_API_KEY ?? "";
    await conform("computesdk-e2b", {
      credentials: ["E2B_API_KEY", "TANGLE_API_KEY"],
      secretValues: [apiKey, routerKey],
      createProvider: () => createComputeSdkProvider({
        compute: compute({ provider: e2b({ apiKey }) }),
        router: { key: routerKey },
        ...(process.env.E2B_TEMPLATE ? { template: process.env.E2B_TEMPLATE } : {}),
      }),
    }, (reason) => context.skip(reason));
  });

  it("meets SPEC.md on the docker backing provider from the box image", { timeout: 3_600_000 }, async (context) => {
    const image = process.env.CLI_BRIDGE_BOX_IMAGE ?? "";
    await conform("computesdk-docker", {
      credentials: ["TANGLE_API_KEY", "CLI_BRIDGE_BOX_IMAGE"],
      secretValues: [routerKey],
      createProvider: () => createComputeSdkProvider({
        // @computesdk/docker boots only images it matches to a runtime name, so the box image is set as the raw create option.
        compute: compute({ provider: docker({
          runtime: "node",
          image: { name: "node", pullPolicy: "never" },
          createOptions: { Image: image },
          container: { workdir: BOX_WORKSPACE_DIR, ports: { [`${BRIDGE_PORT}/tcp`]: [{ hostIP: "127.0.0.1" }] } },
        }) }),
        router: { key: routerKey },
      }),
    }, (reason) => context.skip(reason));
  });
});

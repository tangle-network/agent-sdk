import { readFileSync, writeFileSync } from "node:fs";
import { Sandbox } from "@tangle-network/sandbox";
import { formatLiveReport, runLiveProfileConformance } from "@tangle-network/agent-provider-testkit";
import { describe, expect, it } from "vitest";
import { createTangleProvider } from "./index.js";

const model = process.env.LIVE_CONFORMANCE_MODEL ?? "glm-5.3";
const client = () => new Sandbox({ apiKey: process.env.TANGLE_API_KEY ?? "", baseUrl: process.env.TANGLE_SANDBOX_URL ?? "https://sandbox.tangle.tools" });
// The operator's own native-credential turn: a JSON file with `modelCredentials`, `createInput` and `turn`, naming stored secrets and never their values.
const nativeFixture = process.env.TANGLE_NATIVE_AUTH_FIXTURE
  ? JSON.parse(readFileSync(process.env.TANGLE_NATIVE_AUTH_FIXTURE, "utf8")) as { modelCredentials: NonNullable<Parameters<typeof createTangleProvider>[0]["modelCredentials"]>; createInput?: object; turn?: object }
  : undefined;

describe("live profile conformance", () => {
  it("meets SPEC.md against the Tangle sandbox", { timeout: 3_600_000 }, async (context) => {
    const report = await runLiveProfileConformance({
      name: "tangle",
      credentials: ["TANGLE_API_KEY"],
      harness: "claude-code",
      model,
      createProvider: () => createTangleProvider({ client: client() }),
      nativeAuth: {
        credentials: ["TANGLE_NATIVE_AUTH_FIXTURE"],
        ...(nativeFixture === undefined ? {} : { createProvider: () => createTangleProvider({ client: client(), modelCredentials: nativeFixture.modelCredentials }), createInput: nativeFixture.createInput, turn: nativeFixture.turn }),
      },
      log: (line) => process.stderr.write(`${line}\n`),
    });
    const artifact = process.env.LIVE_CONFORMANCE_ARTIFACT;
    if (artifact !== undefined && artifact !== "") writeFileSync(artifact, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${formatLiveReport(report)}\n`);
    if (report.skipped !== undefined) context.skip(report.skipped);
    expect(report.results.filter((result) => result.status === "fail")).toEqual([]);
  });
});

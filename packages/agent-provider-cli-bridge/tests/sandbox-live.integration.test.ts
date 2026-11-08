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
          harnesses: [harness],
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

  // The regression this pins: a box turn reaching api.openai.com instead of the Router. The Router the
  // provider injects points at a listener inside the box (Docker's bridge network hides the host's
  // loopback), and the listener records what the harness actually dialed.
  it.skipIf(!harnesses.includes("codex"))(
    "dials the Router URL a codex turn is given, not api.openai.com",
    { timeout: 600_000 },
    async (context) => {
      if ((process.env.CLI_BRIDGE_BOX_IMAGE ?? "").trim() === "") context.skip("no CLI_BRIDGE_BOX_IMAGE");
      const port = 8417;
      const key = "box-parity-dummy-router-key";
      const listener = `require("http").createServer(function (req, res) {
  var body = "";
  req.on("data", function (chunk) { body += chunk; });
  req.on("end", function () {
    require("fs").appendFileSync("/tmp/router-hits.log", req.method + " " + req.url + " auth=" + String(req.headers.authorization) + " body=" + body + "\\n");
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "dummy router: not authorized", type: "invalid_request_error", code: "invalid_api_key" } }));
  });
}).listen(${port}, "127.0.0.1");`;
      const provider = createBridgeSandboxProvider({
        vendor: dockerBoxVendor(process.env.CLI_BRIDGE_BOX_IMAGE ?? ""),
        router: { baseUrl: `http://127.0.0.1:${port}`, key },
      });
      const environment = await provider.create({
        profile: { harness: "codex", model: { default: model } },
        env: { CONFORMANCE_PLAIN: "codex-router-check" },
        name: "codex-router-listener-check",
        metadata: { "conformance-case": "codex-router-listener" },
      });
      try {
        const start = await environment.exec?.(`node -e '${listener}' >/tmp/router-listener.out 2>&1 & echo started`);
        expect(start?.exitCode ?? 1).toBe(0);
        let succeeded = false;
        try {
          for await (const event of environment.stream({ prompt: "Reply with the single word ready.", timeoutMs: 120_000 })) {
            if (JSON.stringify(event).includes("succeeded")) succeeded = true;
          }
        } catch {
          // A key-rejecting Router must fail the turn; the listener log below is the proof of where it went.
        }
        const hits = await environment.exec?.("cat /tmp/router-hits.log");
        expect(hits?.exitCode ?? 1).toBe(0);
        expect(hits?.stdout ?? "").toContain(`POST /v1/responses auth=Bearer ${key}`);
        expect(hits?.stdout ?? "").toContain(`"model":"${model}"`);
        expect(succeeded).toBe(false);
      } finally {
        await environment.destroy();
      }
    },
  );
});

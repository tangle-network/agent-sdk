import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("posts causal links from a packed TypeScript consumer to a real OTLP collector", async () => {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const directory = await mkdtemp(join(tmpdir(), "trace-links-consumer-"));
  const run = (command: string, args: string[], cwd = directory) => {
    try {
      return execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
    } catch (error) {
      const failure = error as { stdout?: Buffer; stderr?: Buffer; message: string };
      throw new Error(
        [failure.message, failure.stdout?.toString(), failure.stderr?.toString()].filter(Boolean).join("\n"),
      );
    }
  };
  const received: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({
      method: request.method,
      path: request.url,
      contentType: request.headers["content-type"],
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    response
      .writeHead(200, { "content-type": "application/json" })
      .end('{"partialSuccess":{"rejectedSpans":"0"}}');
  });
  try {
    const packed = JSON.parse(run("pnpm", ["pack", "--json", "--pack-destination", directory], packageRoot));
    await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
    run("npm", [
      "install",
      packed.filename,
      "--ignore-scripts",
      "--package-lock=false",
      "--no-audit",
      "--no-fund",
    ]);
    await writeFile(
      join(directory, "consumer.ts"),
      `
import { LINK_KIND_ATTR, agentIdentityAttributes, contractSpan, llmSpan, toolSpan, loopSpan, branchSpan, spanLink, steeredBy, type SpanLink } from "@tangle-network/agent-trace-contract";
import { OTLP_SPAN_KIND, otlpTraceExport, readOtlpPartialSuccess, toOtlpAttributes, msToUnixNano, type OtlpSpan } from "@tangle-network/agent-trace-contract/otlp";
const parent: SpanLink = spanLink("spawned_by", "2222222222222222", "11111111111111111111111111111111");
const prior: OtlpSpan = { traceId: "33333333333333333333333333333333", spanId: "4444444444444444", name: "unlinked", kind: OTLP_SPAN_KIND.INTERNAL, startTimeUnixNano: "1", endTimeUnixNano: "2", attributes: [] };
const child: OtlpSpan = { ...prior, spanId: "5555555555555555", name: "child", links: [{ traceId: parent.trace_id, spanId: parent.span_id, traceState: "vendor=value", flags: 1, droppedAttributesCount: 0, attributes: toOtlpAttributes({ [LINK_KIND_ATTR]: String(parent.attributes?.[LINK_KIND_ATTR]) }) }] };
export const envelope = otlpTraceExport(toOtlpAttributes({ "service.name": "packed-consumer" }), { name: "causality" }, [prior, child]);
const base = { traceId: prior.traceId, name: "builder", startTime: "1970-01-01T00:00:00.001Z", agent: { profileName: "packed-agent" }, attributes: agentIdentityAttributes({ harness: "offline" }) };
const logical = [
  contractSpan({ ...base, spanId: "6666666666666666", name: "agent", kind: "AGENT" }),
  llmSpan({ ...base, spanId: "7777777777777777", name: "llm", model: "fixture/model", inputTokens: 3 }),
  toolSpan({ ...base, spanId: "8888888888888888", name: "tool", toolName: "read_file" }),
  loopSpan({ ...base, spanId: "9999999999999999", name: "loop", loopId: "checked-loop", iteration: 2, links: [steeredBy(prior.spanId, prior.traceId)] }),
  branchSpan({ ...base, spanId: "aaaaaaaaaaaaaaaa", name: "branch", branchId: "arm-a" }),
];
const built: OtlpSpan[] = logical.map(span => ({ traceId: span.trace_id, spanId: span.span_id, name: span.name, kind: OTLP_SPAN_KIND.INTERNAL, startTimeUnixNano: msToUnixNano(Date.parse(span.start_time)), endTimeUnixNano: msToUnixNano(Date.parse(span.end_time)), attributes: toOtlpAttributes(JSON.parse(JSON.stringify(span.attributes))), ...(span.links ? { links: span.links.map(link => ({ traceId: link.trace_id, spanId: link.span_id, attributes: toOtlpAttributes(JSON.parse(JSON.stringify(link.attributes))) })) } : {}) }));
export const builders = otlpTraceExport([], { name: "published-builders" }, built);
export { readOtlpPartialSuccess };
`,
    );
    run(process.execPath, [
      join(packageRoot, "node_modules/typescript/bin/tsc"),
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--outDir",
      "compiled",
      "consumer.ts",
    ]);
    const manifest = JSON.parse(
      await readFile(
        join(directory, "node_modules/@tangle-network/agent-trace-contract/package.json"),
        "utf8",
      ),
    );
    expect(manifest.exports["./otlp"].types).toBe("./dist/otlp.d.ts");
    expect(manifest.dependencies).toBeUndefined();
    const consumer = await import(pathToFileURL(join(directory, "compiled/consumer.js")).href);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("collector did not listen");
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(consumer.envelope),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    expect(consumer.readOtlpPartialSuccess(await response.text())).toEqual({ rejectedSpans: 0 });
    expect(received[0]).toEqual({
      method: "POST",
      path: "/v1/traces",
      contentType: "application/json",
      body: {
        resourceSpans: [
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: "packed-consumer" } }] },
            scopeSpans: [
              {
                scope: { name: "causality" },
                spans: [
                  {
                    traceId: "33333333333333333333333333333333",
                    spanId: "4444444444444444",
                    name: "unlinked",
                    kind: 1,
                    startTimeUnixNano: "1",
                    endTimeUnixNano: "2",
                    attributes: [],
                  },
                  {
                    traceId: "33333333333333333333333333333333",
                    spanId: "5555555555555555",
                    name: "child",
                    kind: 1,
                    startTimeUnixNano: "1",
                    endTimeUnixNano: "2",
                    attributes: [],
                    links: [
                      {
                        traceId: "11111111111111111111111111111111",
                        spanId: "2222222222222222",
                        traceState: "vendor=value",
                        flags: 1,
                        droppedAttributesCount: 0,
                        attributes: [{ key: "agent.link.kind", value: { stringValue: "spawned_by" } }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    const builderResponse = await fetch(`http://127.0.0.1:${address.port}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(consumer.builders),
      signal: AbortSignal.timeout(5000),
    });
    expect(builderResponse.status).toBe(200);
    const common = [
      { key: "agent.profile.name", value: { stringValue: "packed-agent" } },
      { key: "agent.harness", value: { stringValue: "offline" } },
    ];
    expect(received[1]).toMatchObject({
      body: {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    name: "agent",
                    startTimeUnixNano: "1000000",
                    attributes: expect.arrayContaining([
                      ...common,
                      { key: "openinference.span.kind", value: { stringValue: "AGENT" } },
                    ]),
                  },
                  {
                    name: "llm",
                    attributes: expect.arrayContaining([
                      ...common,
                      { key: "gen_ai.request.model", value: { stringValue: "fixture/model" } },
                      { key: "gen_ai.usage.input_tokens", value: { intValue: "3" } },
                    ]),
                  },
                  {
                    name: "tool",
                    attributes: expect.arrayContaining([
                      ...common,
                      { key: "gen_ai.tool.name", value: { stringValue: "read_file" } },
                    ]),
                  },
                  {
                    name: "loop",
                    attributes: expect.arrayContaining([
                      ...common,
                      { key: "agent.loop.id", value: { stringValue: "checked-loop" } },
                    ]),
                    links: [
                      {
                        traceId: "33333333333333333333333333333333",
                        spanId: "4444444444444444",
                        attributes: [{ key: "agent.link.kind", value: { stringValue: "steered_by" } }],
                      },
                    ],
                  },
                  {
                    name: "branch",
                    attributes: expect.arrayContaining([
                      ...common,
                      { key: "agent.branch.id", value: { stringValue: "arm-a" } },
                    ]),
                  },
                ],
              },
            ],
          },
        ],
      },
    });
  } finally {
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

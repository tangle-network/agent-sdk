import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpModelCredentialResolver, parseModelCredentialResolverRequest } from "./node.js";
import { createTangleProvider } from "./index.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });
async function broker(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture listener");
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }));
  return `http://127.0.0.1:${address.port}/v1/model-credentials/resolve`;
}
async function requestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const bearer = "narrow-test-grant".repeat(4);
const input = {
  profile: { name: "researcher", harness: "claude-code" as const, model: { provider: "anthropic", default: "fixture-model", metadata: { credentialSource: "subscription", callerIntent: "untouched" } } },
  idempotencyKey: "runtime:root:node", requestedId: "node", metadata: { root: "run" },
};
const reference = { cliAuth: { account: "opaque-native-account", secretEnv: "SELECTED_NATIVE", format: "token" as const } };

describe("remote account-owner transport", () => {
  it("forwards the full exact create input and fixed deadline over real HTTP, without a signal or owner credentials", async () => {
    const captured: unknown[] = [];
    const url = await broker(async (request, response) => {
      expect(request.headers.authorization).toBe(`Bearer ${bearer}`);
      captured.push(await requestBody(request));
      response.end(JSON.stringify(reference));
    });
    const deadline = "2026-10-01T06:00:00.000Z";
    const resolver = createHttpModelCredentialResolver({ url, bearer, minimumValidUntil: deadline });
    const signal = new AbortController().signal;
    expect(await resolver({ ...input, signal })).toEqual(reference);
    expect(await resolver({ ...input, signal })).toEqual(reference);
    expect(captured).toEqual([{ input, minimumValidUntil: deadline }, { input, minimumValidUntil: deadline }]);
  });

  it("skips the remote owner for managed and unmarked root or child profiles", async () => {
    let calls = 0;
    const url = await broker((_request, response) => { calls++; response.end(JSON.stringify(reference)); });
    const resolver = createHttpModelCredentialResolver({ url, bearer });
    expect(await resolver({ profile: { name: "router-parent" } })).toBeUndefined();
    expect(await resolver({ ...input, profile: { ...input.profile, model: { ...input.profile.model, metadata: { credentialSource: "managed" } } } })).toBeUndefined();
    expect(await resolver(input)).toEqual(reference);
    expect(await resolver({ ...input, idempotencyKey: "runtime:root:child" })).toEqual(reference);
    expect(calls).toBe(2);
  });

  it("refuses malformed intent or missing dispatch identity before contacting the owner", async () => {
    let calls = 0;
    const url = await broker((_request, response) => { calls++; response.end(JSON.stringify(reference)); });
    const resolver = createHttpModelCredentialResolver({ url, bearer });
    await expect(resolver({ profile: input.profile })).rejects.toThrow(/identity/);
    await expect(resolver({ ...input, profile: { ...input.profile, model: { ...input.profile.model, metadata: { credentialSource: "unknown" } } } })).rejects.toThrow(/credentialSource/);
    expect(calls).toBe(0);
  });

  it.each([
    "not-json-private-fixture",
    JSON.stringify({ cliAuth: { ...reference.cliAuth, token: "private-fixture" } }),
    JSON.stringify({ apiKey: "private-fixture" }),
    JSON.stringify({ apiKeyEnv: "GLM_PLAN", baseUrl: "https://plan.example/api", private: "private-fixture" }),
    "x".repeat(65537),
    "null",
  ])("refuses invalid or private owner output before provisioning", async (output) => {
    const url = await broker((_request, response) => { response.end(output); });
    let creates = 0;
    const provider = createTangleProvider({
      client: { async create() { creates++; throw new Error("unexpected provisioning"); } },
      modelCredentials: createHttpModelCredentialResolver({ url, bearer }),
    });
    const pending = provider.create({ profile: input.profile, idempotencyKey: input.idempotencyKey, metadata: input.metadata });
    await expect(pending).rejects.toThrow(/invalid public reference/);
    await expect(pending).rejects.not.toThrow(/private-fixture/);
    expect(creates).toBe(0);
  });

  it("retains sanitized HTTP status without exposing a private refusal body", async () => {
    const url = await broker((_request, response) => { response.writeHead(503); response.end(JSON.stringify({ error: { exitCode: 12, message: "private-owner-diagnostic" } })); });
    const pending = createHttpModelCredentialResolver({ url, bearer })(input);
    await expect(pending).rejects.toMatchObject({ status: 503, exitCode: 12 });
    await expect(pending).rejects.not.toThrow(/private-owner-diagnostic/);
  });

  it("does not follow redirects carrying the pool grant", async () => {
    let leaked = false;
    const destination = await broker((_request, response) => { leaked = true; response.end(JSON.stringify(reference)); });
    const url = await broker((_request, response) => { response.writeHead(307, { location: destination }); response.end(); });
    await expect(createHttpModelCredentialResolver({ url, bearer })(input)).rejects.toThrow(/request failed/);
    expect(leaked).toBe(false);
  });

  it("bounds stalled responses and supports caller cancellation", async () => {
    const url = await broker((_request, response) => { response.writeHead(200); response.flushHeaders(); });
    await expect(createHttpModelCredentialResolver({ url, bearer, timeoutMs: 40 })(input)).rejects.toThrow(/invalid public reference|timed out/);
    const controller = new AbortController();
    const pending = createHttpModelCredentialResolver({ url, bearer })({ ...input, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted|invalid public reference/);
  });

  it.each(["http://external.example/resolve", "https://user:private@example/resolve", "https://example/resolve?grant=private", "https://example/resolve#private"])("refuses unsafe endpoint configuration", (url) => {
    expect(() => createHttpModelCredentialResolver({ url, bearer })).toThrow(/HTTPS or loopback HTTP/);
  });

  it("rejects authority fields, serialized signals and malformed wire deadlines", () => {
    expect(() => parseModelCredentialResolverRequest({ input, namespace: "other-owner" })).toThrow(/contain an input/);
    expect(() => parseModelCredentialResolverRequest({ input: { ...input, signal: {} } })).toThrow(/serialized signal/);
    expect(() => parseModelCredentialResolverRequest({ input, minimumValidUntil: "invalid" })).toThrow(/timestamp/);
    expect(parseModelCredentialResolverRequest({ input })).toEqual({ input });
    const mounted = { ...input, profile: { ...input.profile, resources: { files: [{ path: "analysis.py", resource: { kind: "inline", name: "analysis.py", content: "x".repeat(20_000) } }] } } };
    expect(parseModelCredentialResolverRequest({ input: mounted })).toEqual({ input: mounted });
  });
});

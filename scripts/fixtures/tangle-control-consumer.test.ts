import { createServer } from "node:http";
import { expect, it } from "vitest";
import { Sandbox, type SandboxRuntimeCapabilities } from "@tangle-network/sandbox";
import {
  createTangleProvider,
  type SandboxClientLike,
} from "@tangle-network/agent-provider-tangle";

const { LIVE_MODEL_POLICY, mapLiveCreateInput, proveLiveModelConfig } =
  await import(new URL("./tangle-live-control.mjs", import.meta.url).href);

it("adapts the public Sandbox control surface and rejects a paid route before dispatch", async () => {
  const capabilities: SandboxRuntimeCapabilities = {
    schema: 1,
    agentInterface: "0.49.0",
    sidecarVersion: "1.0.0-packed",
    image: `example/sidecar@sha256:${"c".repeat(64)}`,
    dispatch: { runControlRef: true, executionIdOnAdmission: true },
    cancel: { canonicalRunCancellation: true, digestBound: true, idempotent: true },
    runs: { executionScopedStatus: true, eventReplay: true },
    interactions: { responseDedupe: false },
  };
  const requests: string[] = [];
  let effectiveModel = { mode: "cli", provider: "opencode", model: "glm-5.3-flash-free" };
  let baseUrl = "", created: Record<string, unknown> | undefined;
  const sandboxInfo = () => ({
    id: "sandbox-public-surface", status: "running",
    filesystemIncarnationId: "11111111-1111-4111-8111-111111111111",
    filesystemIncarnationProvenance: "fresh", filesystemIncarnationReadiness: "ready",
    connection: {
      runtimeUrl: `${baseUrl}/v1/sandboxes/sandbox-public-surface/runtime`,
      authToken: "fixture-runtime-token", edgeStatus: "ready",
    },
    createdAt: "2026-08-01T20:00:00.000Z",
  });
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, "http://fixture").pathname;
    requests.push(`${request.method} ${path}`);
    response.setHeader("content-type", "application/json");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (path === "/v1/backends") {
      response.end(JSON.stringify({ backends: [{ type: "opencode", name: "opencode",
        description: "HTTP fixture", callerCredentialOnly: false,
        capabilities: { streaming: true, toolUse: true, reasoning: false,
          multimodal: false, imageInput: false, contextWindow: 100000,
          mcp: true, sessions: true, configurable: true, interactions: [] },
      }], timestamp: new Date(0).toISOString() }));
    } else if (path === "/v1/sandboxes" && request.method === "POST") {
      created = JSON.parse(Buffer.concat(chunks).toString());
      response.end(JSON.stringify(sandboxInfo()));
    } else if (path === "/v1/sandboxes/sandbox-public-surface") {
      response.end(JSON.stringify(sandboxInfo()));
    } else if (path === "/v1/sandboxes/sandbox-public-surface/runtime/config/config") {
      response.end(JSON.stringify({ model: effectiveModel }));
    } else if (path === "/v1/sandboxes/sandbox-public-surface/runtime/capabilities") {
      response.end(JSON.stringify(capabilities));
    } else {
      response.writeHead(404);
      response.end(JSON.stringify({ code: "NOT_FOUND", message: "No other operation is served" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing HTTP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
    const client: SandboxClientLike = new Sandbox({ baseUrl, platformUrl: baseUrl,
      apiKey: "fixture-api-key", trustLocalCliAuth: false, directExec: false });
    // Ephemeral is a public capability ceiling even with the complete SDK surface.
    const provider = createTangleProvider({ client, ephemeral: true });
    const environment = await provider.create({ profile: { name: "packed", harness: "opencode" } });
    expect(created).toMatchObject({ ephemeral: true });
    for (const document of [await provider.capabilities(), environment.capabilities]) {
      expect(document?.branching).toMatchObject({ checkpoint: false, fork: false, confidential: false });
    }
    expect(environment.checkpoint).toBeUndefined();
    expect(environment.fork).toBeUndefined();
    expect(provider.workspaceBranching).toBeUndefined();
    expect(typeof environment.dispatch).toBe("function");
    expect(typeof environment.session).toBe("function");
    expect(requests).toContain("POST /v1/sandboxes");
    expect(requests).toContain("GET /v1/sandboxes/sandbox-public-surface/runtime/capabilities");
    expect(requests.every((request) => !/snapshot|fork|agents\/run/.test(request))).toBe(true);

    const nativeProvider = createTangleProvider({ client, mapCreateInput: mapLiveCreateInput });
    const nativeInput: Parameters<typeof nativeProvider.create>[0] = {
      backend: "opencode",
      profile: { name: "free-public-surface", harness: "opencode", model: {
        provider: LIVE_MODEL_POLICY.provider, default: LIVE_MODEL_POLICY.id,
        small: LIVE_MODEL_POLICY.id, metadata: { credentialSource: "api-key" },
      } },
      workspace: { environment: "universal", repoUrl: "https://github.com/tangle-network/agent-sdk.git",
        gitRef: "main", cwd: { base: "repository", path: "packages/agent-interface" } },
      name: "free-public-surface", idempotencyKey: "free-public-surface",
      metadata: { owner: "agent-sdk-upstream-evidence" },
    };
    const nativeEnvironment = await nativeProvider.create(nativeInput);
    expect(created).toMatchObject({ secrets: [], cwd: "packages/agent-interface",
      backend: { type: "opencode", profile: nativeInput.profile,
        model: { mode: "cli", provider: "opencode", model: "glm-5.3-flash-free" } } });
    expect(created).not.toHaveProperty("env");
    expect(created).not.toHaveProperty("proxySecrets");
    expect(created).toHaveProperty("backend.model", { mode: "cli", provider: "opencode", model: "glm-5.3-flash-free" });
    expect(await proveLiveModelConfig(client, nativeEnvironment.id)).toMatchObject({ effective: effectiveModel,
      servedIdentity: "not-proved-by-config" });
    const createsBeforeRejection = requests.filter((request) => request === "POST /v1/sandboxes").length;
    await expect(nativeProvider.create({ ...nativeInput, env: { OPENCODE_MODEL_API_KEY: "not-a-secret" } }))
      .rejects.toThrow("Unsupported live fixture input env");
    expect(requests.filter((request) => request === "POST /v1/sandboxes")).toHaveLength(createsBeforeRejection);
    effectiveModel = { mode: "api", provider: "tangle-router", model: "glm-5.3" };
    await expect(proveLiveModelConfig(client, nativeEnvironment.id))
      .rejects.toThrow("Effective sandbox model must use the fixed native free lane");
    expect(requests.every((request) => !/agents\/run/.test(request))).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

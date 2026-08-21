import {
  canonicalCandidateDigest,
  interactionResponseCommandDigest,
} from "@tangle-network/agent-interface";
import type {
  InteractionResponseCommand,
  InteractionResponse,
} from "@tangle-network/agent-interface";
import { agentEnvironmentCreateInputDigest } from "@tangle-network/agent-interface/environment-provider";
import { describe, expect, it } from "vitest";
import {
  createCliBridgeProvider,
  defaultCliBridgeCapabilities,
} from "./index.js";
import { cliBridgeEnvironmentId } from "./environment-identity.js";

const environmentId = "cli-environment";
const retainedEnvironmentId = cliBridgeEnvironmentId(
  { backend: "pi", model: "pi" },
  agentEnvironmentCreateInputDigest({
    idempotencyKey: environmentId,
    profile: { name: "pi-agent", harness: "pi" },
  }),
  environmentId,
);
const sessionId = "cli-session";

function command(
  overrides: Partial<InteractionResponseCommand["binding"]> = {},
): InteractionResponseCommand {
  const binding = {
    runId: "cli-run",
    provider: "cli-bridge",
    environmentId: retainedEnvironmentId,
    sessionId,
    executionId: "cli-execution",
    interactionId: "cli-interaction",
    requestDigest: canonicalCandidateDigest("cli-request"),
    ...overrides,
  };
  const response: InteractionResponse = {
    id: binding.interactionId,
    outcome: "accepted",
    data: { grant: ["allow_once"] },
  };
  return {
    operationId: "cli-operation",
    binding,
    response,
    commandDigest: interactionResponseCommandDigest({ binding, response }),
  };
}

describe("CLI Bridge interaction responses", () => {
  it("publishes only the retained Pi interaction contract", () => {
    expect(defaultCliBridgeCapabilities("pi").interactions).toEqual({
      kinds: ["permission"],
      answerFieldTypes: ["select"],
      responseScopes: ["interaction"],
      secretAnswers: false,
      concurrentRequests: false,
      replay: true,
      responseIdempotency: true,
    });
    expect(defaultCliBridgeCapabilities("codex").interactions).toBeUndefined();
    expect(defaultCliBridgeCapabilities().interactions).toBeUndefined();
  });

  it("sends the canonical command to its exact retained run", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local/",
      capabilities: defaultCliBridgeCapabilities("pi"),
      fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push({ url: String(url), body });
        return new Response(
          JSON.stringify({
            operationId: body.operationId,
            binding: body.binding,
            commandDigest: body.commandDigest,
            status: "accepted",
          }),
        );
      },
    });
    const environment = await provider.create({
      idempotencyKey: environmentId,
      profile: { name: "pi-agent", harness: "pi" },
    });
    const exact = command();

    await expect(environment.respondToInteraction?.(exact)).resolves.toMatchObject({
      operationId: exact.operationId,
      status: "accepted",
    });
    expect(requests).toEqual([
      {
        url:
          "http://bridge.local/v1/runs/cli-run/interactions/cli-interaction/respond",
        body: exact,
      },
    ]);
  });

  it("replays the same acknowledgement for a retry of the same command", async () => {
    let calls = 0;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      capabilities: defaultCliBridgeCapabilities("pi"),
      fetch: async (_url, init) => {
        calls += 1;
        const body = JSON.parse(String(init?.body));
        return Response.json({
          operationId: body.operationId,
          binding: body.binding,
          commandDigest: body.commandDigest,
          status: "already_resolved_same",
        });
      },
    });
    const environment = await provider.create({
      idempotencyKey: environmentId,
      profile: { name: "pi-agent", harness: "pi" },
    });
    const exact = command();

    const first = await environment.respondToInteraction!(exact);
    const second = await environment.respondToInteraction!(exact);

    expect(second).toEqual(first);
    expect(calls).toBe(2);
  });

  it("binds a session responder to that session without network use", async () => {
    let calls = 0;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      capabilities: defaultCliBridgeCapabilities("pi"),
      fetch: async () => {
        calls += 1;
        return new Response();
      },
    });
    const environment = await provider.create({
      idempotencyKey: environmentId,
      profile: { name: "pi-agent", harness: "pi" },
    });

    await expect(
      environment
        .session?.(sessionId)
        .respondToInteraction?.(command({ sessionId: "another-session" })),
    ).resolves.toMatchObject({ status: "binding_mismatch" });
    expect(calls).toBe(0);
  });

  it("returns a server binding mismatch for a stale request digest", async () => {
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      capabilities: defaultCliBridgeCapabilities("pi"),
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        return Response.json(
          {
            operationId: body.operationId,
            binding: body.binding,
            commandDigest: body.commandDigest,
            status: "binding_mismatch",
          },
          { status: 409 },
        );
      },
    });
    const environment = await provider.create({
      idempotencyKey: environmentId,
      profile: { name: "pi-agent", harness: "pi" },
    });
    const stale = command({ requestDigest: canonicalCandidateDigest("stale-run") });

    await expect(environment.respondToInteraction!(stale)).resolves.toMatchObject({
      status: "binding_mismatch",
      retryable: false,
    });
  });

  it.each([
    [400, "invalid_response", false],
    [409, "already_resolved_different", false],
    [409, "binding_mismatch", false],
    [409, "cancelled", false],
    [409, "expired", false],
    [429, "transport_failure", true],
    [502, "transport_failure", true],
  ] as const)("classifies HTTP %i %s as retryable=%s", async (status, acknowledgementStatus, retryable) => {
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      capabilities: defaultCliBridgeCapabilities("pi"),
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        return Response.json(
          {
            operationId: body.operationId,
            binding: body.binding,
            commandDigest: body.commandDigest,
            status: acknowledgementStatus,
            message: `fixture ${acknowledgementStatus}`,
            ...(acknowledgementStatus === "transport_failure"
              ? { retryable: true }
              : {}),
          },
          { status },
        );
      },
    });
    const environment = await provider.create({
      idempotencyKey: environmentId,
      profile: { name: "pi-agent", harness: "pi" },
    });

    await expect(environment.respondToInteraction!(command())).resolves.toMatchObject({
      status: acknowledgementStatus,
      retryable,
    });
  });

  it("rejects HTTP 429 when the response effect is not known to be pre-effect", async () => {
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      capabilities: defaultCliBridgeCapabilities("pi"),
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        return Response.json(
          {
            operationId: body.operationId,
            binding: body.binding,
            commandDigest: body.commandDigest,
            status: "transport_failure",
            message: "the provider may already have applied the response",
            retryable: false,
          },
          { status: 429 },
        );
      },
    });
    const environment = await provider.create({
      idempotencyKey: environmentId,
      profile: { name: "pi-agent", harness: "pi" },
    });

    await expect(environment.respondToInteraction!(command())).rejects.toThrow(
      "contradicts HTTP 429",
    );
  });

  it("preserves a server-declared non-retryable unknown effect", async () => {
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      capabilities: defaultCliBridgeCapabilities("pi"),
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        return Response.json(
          {
            operationId: body.operationId,
            binding: body.binding,
            commandDigest: body.commandDigest,
            status: "transport_failure",
            message: "the provider may already have applied the response",
            retryable: false,
          },
          { status: 502 },
        );
      },
    });
    const environment = await provider.create({
      idempotencyKey: environmentId,
      profile: { name: "pi-agent", harness: "pi" },
    });

    await expect(environment.respondToInteraction!(command())).resolves.toMatchObject({
      status: "transport_failure",
      retryable: false,
    });
  });

  it("treats a malformed successful response as uncertain delivery", async () => {
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      capabilities: defaultCliBridgeCapabilities("pi"),
      fetch: async () => new Response("not-json", { status: 200 }),
    });
    const environment = await provider.create({
      idempotencyKey: environmentId,
      profile: { name: "pi-agent", harness: "pi" },
    });

    await expect(environment.respondToInteraction!(command())).resolves.toMatchObject({
      status: "transport_failure",
      retryable: true,
    });
  });

  it("rejects an HTTP and acknowledgement status contradiction", async () => {
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      capabilities: defaultCliBridgeCapabilities("pi"),
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        return Response.json({
          operationId: body.operationId,
          binding: body.binding,
          commandDigest: body.commandDigest,
          status: "accepted",
        }, { status: 502 });
      },
    });
    const environment = await provider.create({
      idempotencyKey: environmentId,
      profile: { name: "pi-agent", harness: "pi" },
    });

    await expect(environment.respondToInteraction!(command())).rejects.toThrow(
      "contradicts HTTP 502",
    );
  });

  it("returns a retryable unknown result when delivery is not confirmed", async () => {
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      capabilities: defaultCliBridgeCapabilities("pi"),
      fetch: async () => {
        throw new Error("connection closed");
      },
    });
    const environment = await provider.create({
      idempotencyKey: environmentId,
      profile: { name: "pi-agent", harness: "pi" },
    });

    await expect(environment.respondToInteraction?.(command())).resolves.toMatchObject({
      status: "transport_failure",
      retryable: true,
    });
  });

  it("rejects an acknowledgement for another operation", async () => {
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      capabilities: defaultCliBridgeCapabilities("pi"),
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            operationId: "other-operation",
            binding: body.binding,
            commandDigest: body.commandDigest,
            status: "accepted",
          }),
        );
      },
    });
    const environment = await provider.create({
      idempotencyKey: environmentId,
      profile: { name: "pi-agent", harness: "pi" },
    });

    await expect(environment.respondToInteraction?.(command())).rejects.toThrow(
      "another operation",
    );
  });

  it("does not expose a response method without the capability", async () => {
    const provider = createCliBridgeProvider({ baseUrl: "http://bridge.local" });
    const environment = await provider.create({
      idempotencyKey: environmentId,
      profile: { name: "codex-agent", harness: "codex" },
    });

    expect(environment.respondToInteraction).toBeUndefined();
    expect(environment.session?.(sessionId).respondToInteraction).toBeUndefined();
  });
});

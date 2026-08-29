import { describe, expect, it } from "vitest";
import {
  ContextTransferRequestSchema,
  canonicalAgentProfileDigest,
  contextTransferRequestDigest,
  portableContextPlanDigest,
  portableConversationContextDigest,
  type AgentProfile,
  type ContextTransferRequest,
  type ContextTransferReceipt,
} from "@tangle-network/agent-interface";
import { createCliBridgeProvider, defaultCliBridgeCapabilities } from "./index.js";
import { prepareCliBridgeRun } from "./retained-run-state.js";
import { toRetainedTurnBody } from "./wire.js";

const profile: AgentProfile = { name: "destination", harness: "codex" };

function request(): ContextTransferRequest {
  const contextMaterial = {
    source: {
      runId: "run-source",
      messageId: "message-source",
      provider: "cli-bridge",
      environmentId: "environment-source",
      sessionId: "session-source",
      executionId: "execution-source",
      requestDigest: `sha256:${"a".repeat(64)}` as const,
    },
    completeness: "complete" as const,
    messages: [{
      id: "message-source",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "portable marker" }],
      timestamp: "2026-08-01T20:00:00.000Z",
    }],
    attachments: [],
  };
  const context = {
    ...contextMaterial,
    digest: portableConversationContextDigest(contextMaterial),
  };
  const planMaterial = {
    planId: "plan-transfer",
    source: context,
    destination: {
      runner: "codex",
      provider: "cli-bridge",
      environmentId: "environment-handoff-exact",
      sessionId: "session-handoff-exact",
      runId: "run-handoff-exact",
      executionId: "execution-handoff-exact",
      model: "gpt-5.6",
      profileDigest: canonicalAgentProfileDigest(profile),
    },
    messages: [{
      messageId: "message-source",
      action: "include" as const,
      parts: [{ partIndex: 0, action: "include" as const }],
    }],
    context,
    requiresAcceptance: false,
  };
  const plan = { ...planMaterial, digest: portableContextPlanDigest(planMaterial) };
  const material = {
    operationId: "operation-transfer",
    plan,
    acceptance: {
      planDigest: plan.digest,
      acceptedAt: "2026-08-01T20:00:01.000Z",
      acceptedBy: "system" as const,
    },
  };
  return ContextTransferRequestSchema.parse({
    ...material,
    requestDigest: contextTransferRequestDigest(material),
  });
}

function receipt(
  transfer: ContextTransferRequest,
  status: "accepted" | "replayed",
): ContextTransferReceipt {
  return {
    status,
    operationId: transfer.operationId,
    requestDigest: transfer.requestDigest,
    planDigest: transfer.plan.digest,
    contextDigest: transfer.plan.context.digest,
    source: transfer.plan.source.source,
    destination: transfer.plan.destination,
    provider: transfer.plan.destination.provider,
    environmentId: transfer.plan.destination.environmentId,
    sessionId: transfer.plan.destination.sessionId,
    runId: transfer.plan.destination.runId,
    executionId: transfer.plan.destination.executionId,
    sessionCreatedForOperationId: transfer.operationId,
    sessionCreatedAt: "2026-08-01T20:00:02.000Z",
    transferredMessageIds: ["message-source"],
    omittedMessageIds: [],
    admittedAt: "2026-08-01T20:00:03.000Z",
  };
}

describe("CLI Bridge portable context", () => {
  it("transfers and looks up the exact durable receipt", async () => {
    const transfer = request();
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local/",
      capabilities: defaultCliBridgeCapabilities("codex"),
      fetch: async (url, init) => {
        calls.push({
          method: init?.method ?? "GET",
          url: String(url),
          body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        });
        return Response.json(receipt(
          transfer,
          init?.method === "POST" ? "accepted" : "replayed",
        ));
      },
    });

    await expect(provider.contextTransfer?.transfer(transfer)).resolves.toEqual(
      receipt(transfer, "accepted"),
    );
    await expect(provider.contextTransfer?.lookup(transfer)).resolves.toEqual(
      receipt(transfer, "replayed"),
    );
    expect(calls).toEqual([
      {
        method: "POST",
        url: "http://bridge.local/v1/context-transfers",
        body: transfer,
      },
      {
        method: "GET",
        url: `http://bridge.local/v1/context-transfers/${transfer.operationId}?request_digest=${encodeURIComponent(transfer.requestDigest)}`,
        body: undefined,
      },
    ]);
  });

  it("turns an invalid bridge receipt into a retryable transport failure", async () => {
    const transfer = request();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      capabilities: defaultCliBridgeCapabilities("codex"),
      fetch: async () => Response.json({ ...receipt(transfer, "accepted"), runId: "wrong-run" }),
    });

    await expect(provider.contextTransfer?.transfer(transfer)).resolves.toMatchObject({
      status: "transport_failure",
      operationId: transfer.operationId,
      requestDigest: transfer.requestDigest,
      retryable: true,
    });
  });

  it("uses every accepted destination coordinate in the environment and turn", async () => {
    const transfer = request();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      capabilities: defaultCliBridgeCapabilities("codex"),
      defaultModel: "codex/gpt-5.6",
      fetch: async () => new Response(),
    });
    const environment = await provider.create({
      profile,
      backend: "codex",
      requestedId: transfer.plan.destination.environmentId,
      idempotencyKey: transfer.operationId,
    });
    expect(environment.id).toBe(transfer.plan.destination.environmentId);

    const prepared = prepareCliBridgeRun(
      { baseUrl: "http://bridge.local", defaultModel: "codex/gpt-5.6" },
      { profile, backend: "codex", requestedId: environment.id },
      {
        prompt: "continue from the marker",
        turnId: "turn-destination",
        sessionId: transfer.plan.destination.sessionId,
        executionId: transfer.plan.destination.executionId,
        contextTransfer: transfer,
      },
      "cli-bridge",
      environment.id,
      true,
    );
    expect(prepared.run).toMatchObject({
      id: transfer.plan.destination.runId,
      environmentId: transfer.plan.destination.environmentId,
      sessionId: transfer.plan.destination.sessionId,
      executionId: transfer.plan.destination.executionId,
    });
    expect(JSON.parse(prepared.run.requestBody)).toMatchObject({
      run_id: transfer.plan.destination.runId,
      environment_id: transfer.plan.destination.environmentId,
      session_id: transfer.plan.destination.sessionId,
      execution_id: transfer.plan.destination.executionId,
      context_transfer: transfer,
    });
    expect(toRetainedTurnBody(prepared.turn, prepared.run, "cli-bridge")).toMatchObject({
      run_id: transfer.plan.destination.runId,
      environment_id: transfer.plan.destination.environmentId,
      context_transfer: transfer,
    });
  });

  it("recovers a caller-owned environment route from its durable transfer receipt", async () => {
    const transfer = request();
    const urls: string[] = [];
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      capabilities: defaultCliBridgeCapabilities("codex"),
      fetch: async (url) => {
        urls.push(String(url));
        return Response.json(receipt(transfer, "replayed"));
      },
    });

    const environment = await provider.get?.(transfer.plan.destination.environmentId);
    expect(environment).toMatchObject({
      id: transfer.plan.destination.environmentId,
      provider: "cli-bridge",
    });
    expect(environment?.capabilities?.contextTransfer).toEqual({
      freshSession: true,
      requestIdempotency: true,
      lookup: true,
    });
    expect(urls).toEqual([
      `http://bridge.local/v1/context-transfer-environments/${transfer.plan.destination.environmentId}`,
    ]);
  });

  it("refuses a turn that tries to override an accepted destination", () => {
    const transfer = request();
    expect(() => prepareCliBridgeRun(
      { baseUrl: "http://bridge.local", defaultModel: "codex/gpt-5.6" },
      { profile, backend: "codex", requestedId: transfer.plan.destination.environmentId },
      {
        prompt: "continue",
        turnId: "turn-destination",
        sessionId: "wrong-session",
        executionId: transfer.plan.destination.executionId,
        contextTransfer: transfer,
      },
      "cli-bridge",
      transfer.plan.destination.environmentId,
      true,
    )).toThrow(/targets another destination/);
  });
});

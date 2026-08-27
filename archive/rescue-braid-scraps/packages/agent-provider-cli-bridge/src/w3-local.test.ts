import { describe, expect, it } from "vitest";
import {
  AgentExactRunControlRefSchema,
  agentRunCancellationRequestDigest,
  interactionResponseCommandDigest,
} from "@tangle-network/agent-interface";
import { createCliBridgeProvider } from "./index.js";

function exactRun(value: unknown) {
  return AgentExactRunControlRefSchema.parse(value);
}

describe("live retained bridge contract", () => {
  it.skipIf(!process.env.CLI_BRIDGE_LIVE_URL)(
    "creates and inspects a retained session on a real local server without starting a model turn",
    async () => {
      const baseUrl = process.env.CLI_BRIDGE_LIVE_URL!;
      const sessionId = `provider-contract-${Date.now()}`;
      const model = process.env.CLI_BRIDGE_LIVE_MODEL ?? "pi/test";
      const bearerToken = process.env.CLI_BRIDGE_LIVE_TOKEN;
      const provider = createCliBridgeProvider({
        baseUrl,
        bearerToken,
        defaultModel: model,
      });
      let environment: Awaited<ReturnType<typeof provider.create>> | undefined;
      try {
        environment = await provider.create({
          profile: { name: "w3-provider-contract", harness: "pi", model: { default: model } },
          idempotencyKey: sessionId,
        });
        expect(environment.id).toBe("cli-bridge");
        expect(environment.dispatch).toBeTypeOf("function");
        expect(environment.session).toBeTypeOf("function");
        expect(await provider.capabilities()).toMatchObject({
          streaming: { live: true, replay: true, detach: true },
          sessions: { continue: true, list: true, messages: true },
        });
        const session = environment.session?.(sessionId);
        if (!session) throw new Error("retained session method was not exposed");
        await expect(session.status()).resolves.toBe("pending");
      } finally {
        await environment?.destroy?.();
        await fetch(`${baseUrl.replace(/\/+$/u, "")}/v1/sessions/${encodeURIComponent(sessionId)}/close`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
          },
          body: "{}",
        }).then((response) => response.text());
      }
    },
  );

  it.skipIf(!process.env.CLI_BRIDGE_LIVE_URL || process.env.CLI_BRIDGE_LIVE_TURN !== "1")(
    "completes one retained turn through the provider and installed Pi subscription",
    async () => {
      const baseUrl = process.env.CLI_BRIDGE_LIVE_URL!;
      const model = process.env.CLI_BRIDGE_LIVE_MODEL ?? "pi/deepseek/deepseek-v4-pro";
      const sessionId = `provider-live-turn-${Date.now()}`;
      const provider = createCliBridgeProvider({
        baseUrl,
        defaultModel: model,
        bearerToken: process.env.CLI_BRIDGE_LIVE_TOKEN,
      });
      const environment = await provider.create({
        profile: { name: "w3-provider-live-turn", harness: "pi", model: { default: model } },
        idempotencyKey: sessionId,
      });
      try {
        const dispatched = await environment.dispatch?.({
          prompt: "Reply with exactly: braid provider live.",
          executionId: "provider-live-turn",
        });
        if (!dispatched?.controlRef || !environment.session) {
          throw new Error("retained provider did not return exact run control");
        }
        expect(dispatched.controlRef).toMatchObject({
          provider: "cli-bridge",
          environmentId: "cli-bridge",
          sessionId,
          executionId: "provider-live-turn",
        });
        const result = await environment.session(sessionId, {
          controlRef: dispatched.controlRef,
        }).result();
        expect(result).toMatchObject({
          success: true,
          sessionId,
          metadata: {
            runId: dispatched.controlRef.runId,
            executionId: "provider-live-turn",
            requestDigest: dispatched.controlRef.requestDigest,
          },
        });
        expect(result.text.trim()).toBe("braid provider live.");
      } finally {
        await environment.destroy?.();
      }
    },
    240_000,
  );

  it.skipIf(!process.env.CLI_BRIDGE_LIVE_URL || process.env.CLI_BRIDGE_LIVE_TURN !== "1")(
    "answers a real Pi permission through the retained provider",
    async () => {
      const model = process.env.CLI_BRIDGE_LIVE_MODEL ?? "pi/deepseek/deepseek-v4-pro";
      const sessionId = `provider-live-interaction-${Date.now()}`;
      const provider = createCliBridgeProvider({
        baseUrl: process.env.CLI_BRIDGE_LIVE_URL!,
        defaultModel: model,
        bearerToken: process.env.CLI_BRIDGE_LIVE_TOKEN,
      });
      const environment = await provider.create({
        profile: { name: "w3-provider-live-interaction", harness: "pi", model: { default: model } },
        idempotencyKey: sessionId,
      });
      try {
        const dispatched = await environment.dispatch?.({
          prompt: "You must use the read tool to read package.json before answering. Then reply with exactly: provider permission resumed.",
          executionId: "provider-live-interaction-execution",
        });
        if (!dispatched?.controlRef || !environment.session) {
          throw new Error("retained provider did not return interaction control");
        }
        const session = environment.session(sessionId, { controlRef: dispatched.controlRef });
        let interactionId: string | undefined;
        for await (const event of session.events({
          executionId: dispatched.controlRef.executionId,
        })) {
          if (event.normalized?.type === "interaction") {
            interactionId = event.normalized.request.id;
            break;
          }
        }
        if (!interactionId || !session.respondToInteraction) {
          throw new Error("retained provider did not expose the real Pi permission");
        }
        const run = exactRun(dispatched.controlRef);
        const binding = {
          runId: run.runId,
          provider: run.provider,
          environmentId: run.environmentId,
          sessionId,
          executionId: run.executionId,
          interactionId,
          requestDigest: run.requestDigest,
        };
        const response = {
          id: interactionId,
          outcome: "accepted" as const,
          data: { grant: ["allow_once"] },
        };
        const command = {
          operationId: "provider-live-interaction-response",
          binding,
          response,
          commandDigest: interactionResponseCommandDigest({ binding, response }),
        };
        const acknowledgement = await session.respondToInteraction(command);
        expect(acknowledgement).toMatchObject({
          operationId: command.operationId,
          binding: command.binding,
          status: "accepted",
        });
        await expect(session.respondToInteraction(command)).resolves.toEqual(acknowledgement);
        await expect(session.result()).resolves.toMatchObject({
          success: true,
          text: "provider permission resumed.",
          sessionId,
        });
      } finally {
        await environment.destroy?.();
      }
    },
    240_000,
  );

  it.skipIf(!process.env.CLI_BRIDGE_LIVE_URL || process.env.CLI_BRIDGE_LIVE_TURN !== "1")(
    "cancels a real Pi process through the retained provider exactly once",
    async () => {
      const model = process.env.CLI_BRIDGE_LIVE_MODEL ?? "pi/deepseek/deepseek-v4-pro";
      const sessionId = `provider-live-cancel-${Date.now()}`;
      const provider = createCliBridgeProvider({
        baseUrl: process.env.CLI_BRIDGE_LIVE_URL!,
        defaultModel: model,
        bearerToken: process.env.CLI_BRIDGE_LIVE_TOKEN,
      });
      const environment = await provider.create({
        profile: { name: "w3-provider-live-cancel", harness: "pi", model: { default: model } },
        idempotencyKey: sessionId,
      });
      try {
        const dispatched = await environment.dispatch?.({
          prompt: "You must use the read tool to read package.json before answering.",
          executionId: "provider-live-cancel-execution",
        });
        if (!dispatched?.controlRef || !environment.session) {
          throw new Error("retained provider did not return cancellation control");
        }
        const session = environment.session(sessionId, { controlRef: dispatched.controlRef });
        for await (const event of session.events({
          executionId: dispatched.controlRef.executionId,
        })) {
          if (event.normalized?.type === "interaction") break;
        }
        if (!session.cancelRun) throw new Error("retained provider did not expose cancellation");
        const material = {
          operationId: "provider-live-cancel-operation",
          run: exactRun(dispatched.controlRef),
          reason: "provider live cancellation proof",
        };
        const request = {
          ...material,
          requestDigest: agentRunCancellationRequestDigest(material),
        };
        const acknowledgement = await session.cancelRun(request);
        expect(acknowledgement).toMatchObject({
          operationId: material.operationId,
          status: "accepted",
          effect: "cancelled",
          run: exactRun(dispatched.controlRef),
        });
        await expect(session.cancelRun(request)).resolves.toEqual(acknowledgement);
        await expect(session.status()).resolves.toBe("cancelled");

        const changedMaterial = { ...material, reason: "changed cancellation reason" };
        await expect(session.cancelRun({
          ...changedMaterial,
          requestDigest: agentRunCancellationRequestDigest(changedMaterial),
        })).resolves.toMatchObject({ status: "conflict", effect: "unknown" });
      } finally {
        await environment.destroy?.();
      }
    },
    240_000,
  );
});

import { describe, expect, it } from "vitest";
import { createCliBridgeProvider } from "./index.js";

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
          },
        });
        expect(result.text.trim()).toBe("braid provider live.");
      } finally {
        await environment.destroy?.();
      }
    },
    240_000,
  );
});

import { describe, expect, it } from "vitest";
import { createCliBridgeProvider } from "@tangle-network/agent-provider-cli-bridge";
import { startActualBridge } from "./actual-bridge.js";

const actualBridge = process.env.CLI_BRIDGE_INTEGRATION_ROOT?.trim() ? describe : describe.skip;
actualBridge("actual cli-bridge native response evidence", () => {
  it("retains observed identity and measured aggregate usage through HTTP and replay", async () => {
    const bridge = await startActualBridge("claude");
    try {
      const options = { baseUrl: bridge.baseUrl, defaultModel: "claude/requested-model" };
      const provider = createCliBridgeProvider(options);
      const environment = await provider.create({
        idempotencyKey: "sdk-provider-evidence-environment",
        profile: { name: "evidence", harness: "claude-code" },
        workspace: { cwd: { base: "host", path: bridge.projectDir } },
      });
      const reference = await environment.dispatch!({
        prompt: "unique measured evidence", sessionId: "sdk-evidence-session",
        executionId: "sdk-evidence-run", turnId: "sdk-evidence-turn",
      });
      const ref = reference.controlRef;
      if (!ref) throw new Error("actual Bridge returned no control reference");
      const session = environment.session!(ref.sessionId, { controlRef: ref });
      const result = await session.result();
      expect(result.success, bridge.logs()).toBe(true);
      expect(result.metadata).toMatchObject({
        provider_model: "provider-observed", provider_models: ["provider-observed"],
        provider_usage: { prompt_tokens: 15, completion_tokens: 11, estimated: false },
      });
      expect(result.usage).toMatchObject({ inputTokens: 15, outputTokens: 11 });
      expect(result.events?.some(event => event.usageMode === "delta" &&
        (event.providerEvent as { usage?: { estimated?: boolean } })?.usage?.estimated === false)).toBe(true);
      const reconstructed = await createCliBridgeProvider(options).get(environment.id);
      const replay = await reconstructed.session!(ref.sessionId, { controlRef: ref }).result();
      expect(replay.metadata).toEqual(result.metadata);
      expect(replay.usage).toEqual(result.usage);
    } finally {
      await bridge.stop();
    }
  }, 45_000);
});

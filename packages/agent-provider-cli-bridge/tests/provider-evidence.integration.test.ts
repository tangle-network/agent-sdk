import { describe, expect, it } from "vitest";
const { createCliBridgeProvider } = await import(
  process.env.CLI_BRIDGE_PROVIDER_MODULE ?? "@tangle-network/agent-provider-cli-bridge"
) as typeof import("@tangle-network/agent-provider-cli-bridge");
import { startActualBridge } from "./actual-bridge.js";

const actualBridge = process.env.CLI_BRIDGE_INTEGRATION_ROOT?.trim() ? describe : describe.skip;
actualBridge("actual cli-bridge native response evidence", () => {
  it.each(["unique", "missing", "synthetic", "application-json", "conflict", "ring-conflict", "duplicate", "partial", "estimated", "zero"])(
    "retains %s evidence through the actual child, HTTP and replay", async (scenario) => {
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
        prompt: `evidence-case:${scenario}`, sessionId: "sdk-evidence-session",
        executionId: "sdk-evidence-run", turnId: "sdk-evidence-turn",
      });
      const ref = reference.controlRef;
      if (!ref) throw new Error("actual Bridge returned no control reference");
      const session = environment.session!(ref.sessionId, { controlRef: ref });
      const result = await session.result();
      expect(result.success, bridge.logs()).toBe(true);
      const metadata = result.metadata ?? {};
      const rawUsage = metadata.provider_usage as Record<string, unknown>;
      expect(rawUsage).toBeDefined();
      if (["missing", "synthetic", "application-json"].includes(scenario)) {
        expect(metadata.provider_model).toBeUndefined();
        expect(metadata.provider_models).toBeUndefined();
      } else if (["conflict", "ring-conflict"].includes(scenario)) {
        expect(metadata.provider_model).toBeUndefined();
        expect(metadata.provider_models).toEqual(["provider-observed", "other-observation"]);
      } else {
        expect(metadata.provider_model).toBe("provider-observed");
        expect(metadata.provider_models).toEqual(["provider-observed"]);
      }
      if (scenario === "partial") {
        expect(rawUsage.estimated).toBe(false);
        expect(rawUsage.prompt_tokens).toBeUndefined();
        expect(rawUsage.completion_tokens).toBe(11);
        expect(rawUsage.fresh_input_tokens).toBe(3);
        expect(result.usage).toBeUndefined();
      } else if (scenario === "estimated") {
        expect(rawUsage.estimated).toBe(true);
      } else {
        const inputTokens = scenario === "zero" ? 0 : 15;
        const outputTokens = scenario === "zero" ? 0 : 11;
        expect(rawUsage).toMatchObject({ prompt_tokens: inputTokens, completion_tokens: outputTokens, estimated: false });
        expect(result.usage).toMatchObject({ inputTokens, outputTokens });
        expect(rawUsage.cost).toBeUndefined();
      }
      if (scenario === "ring-conflict") {
        expect(result.events).toHaveLength(1024);
        expect(result.events?.some(event => event.data.provider_models !== undefined)).toBe(false);
      }
      const reconstructed = await createCliBridgeProvider(options).get(environment.id);
      const replay = await reconstructed.session!(ref.sessionId, { controlRef: ref }).result();
      expect(replay.metadata).toEqual(result.metadata);
      expect(replay.usage).toEqual(result.usage);
    } finally {
      await bridge.stop();
    }
  }, 45_000);
});

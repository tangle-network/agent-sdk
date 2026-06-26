import { describe, expect, it } from "vitest";
import type {
  AgentEnvironmentProvider,
  AgentTurnInput,
} from "@tangle-network/agent-interface/environment-provider";
import { runAgentEnvironmentProviderConformance } from "./index.js";

describe("runAgentEnvironmentProviderConformance", () => {
  it("accepts a provider that implements the required lifecycle", async () => {
    const report = await runAgentEnvironmentProviderConformance({
      name: "fake",
      createProvider: () => fakeProvider(),
    });

    expect(report.provider).toBe("fake");
    expect(report.checked).toContain("stream");
    expect(report.checked).toContain("workspace-exec");
  });
});

function fakeProvider(): AgentEnvironmentProvider {
  const files = new Map<string, string>();
  return {
    name: "fake",
    capabilities: () => ({
      profile: {
        namedProfiles: true,
        systemPrompt: true,
        instructions: true,
        tools: true,
        permissions: true,
        mcp: true,
        subagents: true,
        resources: {
          files: true,
          instructions: true,
          tools: true,
          skills: true,
          agents: true,
          commands: true,
        },
        hooks: true,
        modes: true,
        runtimeUpdate: true,
        validation: true,
      },
      streaming: { live: true, replay: false, detach: false, turnIdempotency: true },
      sessions: { continue: true, list: false, messages: false },
      workspace: { read: true, write: true, exec: true, git: false, upload: false, download: false },
      branching: { checkpoint: false, fork: false },
      placement: false,
      usage: true,
      confidential: false,
    }),
    async create() {
      return {
        id: "env-1",
        provider: "fake",
        status: async () => "running",
        async *stream(input: AgentTurnInput) {
          yield {
            type: "result",
            data: { finalText: input.prompt ?? "ok" },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
        read: async (path: string) => files.get(path) ?? "",
        write: async (path: string, content: string) => {
          files.set(path, content);
        },
        exec: async () => ({ exitCode: 0, stdout: "ok\n", stderr: "" }),
        destroy: async () => {},
      };
    },
  };
}

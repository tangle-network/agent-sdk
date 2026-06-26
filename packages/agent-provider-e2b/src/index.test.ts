import { describe, expect, it } from "vitest";
import { runAgentEnvironmentProviderConformance } from "@tangle-network/agent-provider-testkit";
import { createE2BProvider, type E2BSandboxClass } from "./index.js";

describe("createE2BProvider", () => {
  it("wraps E2B sandboxes as provider environments", async () => {
    const files = new Map<string, string>();
    const Sandbox: E2BSandboxClass = {
      async create() {
        return {
          sandboxId: "e2b-1",
          commands: {
            run: async (command) => ({ exitCode: 0, stdout: `ran:${command}`, stderr: "" }),
          },
          files: {
            read: async (path) => files.get(path) ?? "",
            write: async (path, content) => {
              files.set(path, content);
            },
          },
          kill: async () => {},
        };
      },
    };
    const provider = createE2BProvider({
      Sandbox,
      turnCommand: ({ prompt }) => `agent ${prompt}`,
    });

    await expect(
      runAgentEnvironmentProviderConformance({
        name: "e2b",
        createProvider: () => provider,
      }),
    ).resolves.toMatchObject({ provider: "e2b" });

    const environment = await provider.create({ profile: "worker" });
    const events = [];
    for await (const event of environment.stream({ prompt: "hello" })) events.push(event);
    expect(events.at(-1)).toMatchObject({ data: { finalText: "ran:agent hello" } });
  });
});

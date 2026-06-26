import { describe, expect, it } from "vitest";
import { runAgentEnvironmentProviderConformance } from "@tangle-network/agent-provider-testkit";
import {
  createComputeSdkProvider,
  type ComputeSdkLike,
} from "./index.js";

describe("createComputeSdkProvider", () => {
  it("wraps ComputeSDK sandboxes as provider environments", async () => {
    const files = new Map<string, string>();
    const compute: ComputeSdkLike = {
      sandbox: {
        async create() {
          return {
            sandboxId: "compute-1",
            runCommand: async (command) => ({ exitCode: 0, stdout: `ran:${command}`, stderr: "" }),
            filesystem: {
              readFile: async (path) => files.get(path) ?? "",
              writeFile: async (path, content) => {
                files.set(path, content);
              },
            },
          };
        },
        destroy: async () => {},
      },
    };
    const provider = createComputeSdkProvider({
      compute,
      turnCommand: ({ prompt }) => `agent ${prompt}`,
    });

    await expect(
      runAgentEnvironmentProviderConformance({
        name: "compute",
        createProvider: () => provider,
      }),
    ).resolves.toMatchObject({ provider: "computesdk" });

    const environment = await provider.create({ profile: "worker" });
    const events = [];
    for await (const event of environment.stream({ prompt: "hello" })) events.push(event);
    expect(events.at(-1)).toMatchObject({ data: { finalText: "ran:agent hello" } });
  });
});

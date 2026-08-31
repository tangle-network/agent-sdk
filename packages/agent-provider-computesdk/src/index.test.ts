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

  it("maps repository cwd references and rejects host references", async () => {
    const createOptions: Array<Record<string, unknown>> = [];
    let nextId = 0;
    const compute: ComputeSdkLike = {
      sandbox: {
        async create(options) {
          createOptions.push(options ?? {});
          nextId += 1;
          return {
            sandboxId: `compute-cwd-${nextId}`,
            runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          };
        },
      },
    };
    const provider = createComputeSdkProvider({ compute });

    await provider.create({
      profile: { name: "repository-cwd" },
      workspace: { cwd: { base: "repository", path: "./packages//agent-interface/." } },
    });
    expect(createOptions[0]).toMatchObject({ cwd: "packages/agent-interface" });
    expect((await provider.capabilities()).workspace.cwdBases).toEqual({
      repository: true,
      host: false,
    });

    await expect(
      provider.create({
        profile: { name: "host-cwd" },
        workspace: { cwd: { base: "host", path: "/workspace" } },
      }),
    ).rejects.toThrow('ComputeSDK supports workspace cwd base "repository", not "host"');
    expect(createOptions).toHaveLength(1);
  });
});

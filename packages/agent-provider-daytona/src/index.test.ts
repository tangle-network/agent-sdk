import { describe, expect, it } from "vitest";
import { runAgentEnvironmentProviderConformance } from "@tangle-network/agent-provider-testkit";
import { createDaytonaProvider, type DaytonaLike } from "./index.js";

describe("createDaytonaProvider", () => {
  it("wraps Daytona workspaces as provider environments", async () => {
    const files = new Map<string, string>();
    const daytona: DaytonaLike = {
      async create() {
        return {
          id: "daytona-1",
          process: {
            executeCommand: async (command: string) => ({ exitCode: 0, stdout: `ran:${command}`, stderr: "" }),
          },
          fs: {
            readFile: async (path: string) => files.get(path) ?? "",
            writeFile: async (path: string, content: string) => {
              files.set(path, content);
            },
          },
          delete: async () => {},
        };
      },
    };
    const provider = createDaytonaProvider({
      daytona,
      turnCommand: ({ prompt }) => `agent ${prompt}`,
    });

    await expect(
      runAgentEnvironmentProviderConformance({
        name: "daytona",
        createProvider: () => provider,
      }),
    ).resolves.toMatchObject({ provider: "daytona" });

    const environment = await provider.create({ profile: "worker" });
    const events = [];
    for await (const event of environment.stream({ prompt: "hello" })) events.push(event);
    expect(events.at(-1)).toMatchObject({ data: { finalText: "ran:agent hello" } });
  });

  it("rejects unsupported keyed or secret creates and cleans mapping failures", async () => {
    let allocations = 0;
    let sandboxCleanup = 0;
    const daytona: DaytonaLike = {
      async create() {
        allocations += 1;
        return {
          delete: async () => {
            sandboxCleanup += 1;
          },
        };
      },
    };
    const provider = createDaytonaProvider({ daytona });

    await expect(
      provider.create({ profile: { name: "worker" }, idempotencyKey: "unsupported" }),
    ).rejects.toThrow(/cannot guarantee durable/);
    await expect(
      provider.create({ profile: { name: "worker" }, secrets: ["TOKEN"] }),
    ).rejects.toThrow(/does not support.*secret/);
    await expect(provider.create({ profile: { name: "worker" } })).rejects.toThrow(
      /returned no id/,
    );
    expect(allocations).toBe(1);
    expect(sandboxCleanup).toBe(1);

    const mappedProvider = createDaytonaProvider({
      daytona,
      mapCreateInput: () => ({ signal: undefined }),
    });
    await expect(mappedProvider.create({ profile: { name: "worker" } })).rejects.toThrow(
      /must not map generic signal/,
    );
  });
});

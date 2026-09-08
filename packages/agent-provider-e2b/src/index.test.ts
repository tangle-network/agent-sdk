import { describe, expect, it } from "vitest";
import { runAgentEnvironmentProviderConformance } from "@tangle-network/agent-provider-testkit";
import { createE2BProvider, type E2BSandboxClass } from "./index.js";

describe("createE2BProvider", () => {
  it("refuses keyed creates before remote effects across restart and lost acknowledgements", async () => {
    let creates = 0;
    let loseAcknowledgement = false;
    const remoteCreate = async () => {
      creates += 1;
      if (loseAcknowledgement) throw new Error("create acknowledgement lost");
      return { id: `remote-${creates}`, sandboxId: `remote-${creates}` };
    };
    const options = { Sandbox: { create: remoteCreate } };
    const first = createE2BProvider(options);
    const input = { profile: "worker", idempotencyKey: "operation-1" };
    await expect(first.create(input)).rejects.toThrow(/does not support durable keyed creation/);
    const restarted = createE2BProvider(options);
    await expect(restarted.create(input)).rejects.toThrow(/does not support durable keyed creation/);
    await expect(restarted.create({ ...input, profile: "changed" })).rejects.toThrow(/does not support durable keyed creation/);
    expect(creates).toBe(0);

    expect((await first.create({ profile: "worker" })).id).toBe("remote-1");
    loseAcknowledgement = true;
    await expect(first.create({ profile: "worker" })).rejects.toThrow("create acknowledgement lost");
    expect(creates).toBe(2);
    await expect(createE2BProvider(options).create(input)).rejects.toThrow(/does not support durable keyed creation/);
    expect(creates).toBe(2);
  });

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
        keyedCreate: "unsupported",
      }),
    ).resolves.toMatchObject({ provider: "e2b" });

    const environment = await provider.create({ profile: "worker" });
    const events = [];
    for await (const event of environment.stream({ prompt: "hello" })) events.push(event);
    expect(events.at(-1)).toMatchObject({ data: { finalText: "ran:agent hello" } });
  });
});

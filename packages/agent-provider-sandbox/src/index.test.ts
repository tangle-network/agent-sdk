import { describe, expect, it } from "vitest";
import { runAgentEnvironmentProviderConformance } from "@tangle-network/agent-provider-testkit";
import type { CreateSandboxOptions, SandboxEvent } from "@tangle-network/sandbox";
import {
  createTangleSandboxProvider,
  type SandboxClientLike,
  type SandboxInstanceLike,
} from "./index.js";

describe("createTangleSandboxProvider", () => {
  it("maps create options, stream events, workspace methods, and dispatch sessions", async () => {
    let createOptions: CreateSandboxOptions | undefined;
    const files = new Map<string, string>();
    const box: SandboxInstanceLike = {
      id: "sbx-1",
      name: "sandbox-one",
      status: "running",
      async *streamPrompt(prompt: string): AsyncIterable<SandboxEvent> {
        yield {
          type: "result",
          data: {
            finalText: `ok:${prompt}`,
            usage: { inputTokens: 2, outputTokens: 3, totalCostUsd: 0.01 },
          },
        } as SandboxEvent;
      },
      dispatchPrompt: async () => ({ sessionId: "sess-1", status: "running", alreadyExisted: true }),
      read: async (path) => files.get(path) ?? "",
      write: async (path, content) => {
        files.set(path, content);
      },
      exec: async () => ({ exitCode: 0, stdout: "ok\n", stderr: "" }),
      delete: async () => {},
    };
    const client: SandboxClientLike = {
      async create(options) {
        createOptions = options;
        return box;
      },
      describePlacement: () => ({ kind: "sibling", sandboxId: "sbx-1" }),
    };
    const provider = createTangleSandboxProvider({ client });

    await expect(
      runAgentEnvironmentProviderConformance({
        name: "sandbox",
        createProvider: () => provider,
        createInput: { profile: { name: "worker" }, backend: "codex" },
      }),
    ).resolves.toMatchObject({ provider: "tangle-sandbox" });

    expect(createOptions).toMatchObject({
      backend: { type: "codex", profile: { name: "worker" } },
    });
    const environment = await provider.create({ profile: "worker", backend: "codex" });
    await expect(environment.dispatch?.({ prompt: "go" })).resolves.toMatchObject({
      id: "sess-1",
      metadata: { alreadyExisted: true },
    });
  });
});

/**
 * Create from a workspace checkpoint.
 *
 * A director whose sandbox was deleted used to continue in an empty box: the runtime composed
 * its task from the coordinator, but the files it wrote were gone (discovery-lab Autopsy A,
 * `autopsy-a-after-20260924b`). A Tangle checkpoint is a Sandbox snapshot, which outlives its
 * box, so create restores it into the new box and carries the new box's own configuration.
 */

import type { CreateSandboxOptions } from "@tangle-network/sandbox";
import type { CreateAgentEnvironmentInput, WorkspaceCheckpointRef } from "@tangle-network/agent-interface";
import { describe, expect, it } from "vitest";
import { createTangleProvider, type SandboxInstanceLike } from "./index.js";

const digest = (fill: string) => `sha256:${fill.repeat(64)}` as const;

function checkpoint(provider = "tangle-sandbox"): WorkspaceCheckpointRef {
  return {
    checkpointId: "snap-1898a9bf44f5",
    provider,
    source: {
      runId: "run-1",
      provider,
      environmentId: "sandbox-lost-box",
      sessionId: "session-1",
      executionId: "execution-1",
      requestDigest: digest("a"),
    },
    idempotencyKey: "checkpoint-key-1",
    requestDigest: digest("b"),
    createdAt: "2026-09-24T14:10:35.000Z",
  };
}

function capturingProvider(mapCreateInput?: (input: CreateAgentEnvironmentInput) => CreateSandboxOptions) {
  const creates: CreateSandboxOptions[] = [];
  const box: SandboxInstanceLike = {
    id: "sandbox-replacement",
    status: "running",
    async *streamPrompt() {},
    delete: async () => undefined,
  };
  const provider = createTangleProvider({
    client: {
      create: async (options?: CreateSandboxOptions) => {
        creates.push(options ?? {});
        return box;
      },
    },
    ...(mapCreateInput === undefined ? {} : { mapCreateInput }),
  });
  return { provider, creates };
}

describe("Tangle create from a workspace checkpoint", () => {
  it("states the capability", async () => {
    const { provider } = capturingProvider();
    expect((await provider.capabilities()).create?.workspaceCheckpoint).toBe(true);
  });

  it("restores the snapshot by its id and source box, with this create's own environment", async () => {
    const { provider, creates } = capturingProvider();

    await provider.create({
      profile: { name: "director" },
      workspace: { checkpoint: checkpoint() },
      env: { RUN: "continued" },
    });

    expect(creates).toHaveLength(1);
    expect(creates[0]?.fromSnapshot).toBe("snap-1898a9bf44f5");
    expect(creates[0]?.fromSandboxId).toBe("sandbox-lost-box");
    expect(creates[0]?.env).toEqual({ RUN: "continued" });
  });

  it("sends no restore fields without a checkpoint", async () => {
    const { provider, creates } = capturingProvider();

    await provider.create({ profile: { name: "director" } });

    expect(creates[0]?.fromSnapshot).toBeUndefined();
    expect(creates[0]?.fromSandboxId).toBeUndefined();
  });

  it("refuses a checkpoint another provider took, before any create", async () => {
    const { provider, creates } = capturingProvider();

    await expect(
      provider.create({ profile: { name: "director" }, workspace: { checkpoint: checkpoint("other") } }),
    ).rejects.toThrow(/taken by provider "other"/);
    expect(creates).toHaveLength(0);
  });

  it("refuses a mapper that drops the restore, so an empty box never passes as a restored one", async () => {
    const { provider, creates } = capturingProvider(() => ({ backend: { type: "opencode" } }) as CreateSandboxOptions);

    await expect(
      provider.create({ profile: { name: "director" }, workspace: { checkpoint: checkpoint() } }),
    ).rejects.toThrow(/must preserve the workspace checkpoint/);
    expect(creates).toHaveLength(0);
  });

  it("refuses a mapper that restores a snapshot the input did not name", async () => {
    const { provider, creates } = capturingProvider(
      () => ({ backend: { type: "opencode" }, fromSnapshot: "snap-other", fromSandboxId: "sandbox-other" }) as CreateSandboxOptions,
    );

    await expect(provider.create({ profile: { name: "director" } })).rejects.toThrow(/did not name/);
    expect(creates).toHaveLength(0);
  });

  it("refuses a checkpoint together with a repository clone", async () => {
    const { provider, creates } = capturingProvider();

    await expect(
      provider.create({
        profile: { name: "director" },
        workspace: { checkpoint: checkpoint(), repoUrl: "https://example.com/repo.git" },
      }),
    ).rejects.toThrow(/both a checkpoint and a repository/);
    expect(creates).toHaveLength(0);
  });
});

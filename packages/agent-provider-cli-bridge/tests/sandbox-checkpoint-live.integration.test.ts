import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentEnvironment } from "@tangle-network/agent-interface/environment-provider";
import { createBridgeSandboxProvider } from "../src/sandbox/index.js";
import { dockerBoxVendor } from "./docker-box-vendor.js";

/**
 * Live proof of the vendor-snapshot seam on a real sandbox runtime: create,
 * checkpoint (docker commit), fork (boot from the committed image), and the
 * state the checkpoint captured must be present on the fork, while the fork is
 * its own environment. Runs wherever the box image and a Docker daemon are.
 */
describe("vendor snapshots through a Docker box", () => {
  it("checkpoints state and forks a new environment that carries it", { timeout: 600_000 }, async (context) => {
    const image = process.env.CLI_BRIDGE_BOX_IMAGE ?? "";
    if (image === "") context.skip("CLI_BRIDGE_BOX_IMAGE is not set; build it with pnpm build:sandbox-image --target docker");
    const provider = createBridgeSandboxProvider({
      vendor: dockerBoxVendor(image),
      router: { key: process.env.TANGLE_API_KEY ?? "unused-until-a-turn" },
      lifetimeMs: 20 * 60 * 1000,
    });

    const marker = `checkpoint-proof-${randomUUID()}`;
    let source: AgentEnvironment | undefined;
    let forked: AgentEnvironment | undefined;
    try {
      source = await provider.create({ profile: { name: "checkpoint-proof", harness: "claude-code" } });
      expect(source.checkpoint).toBeTypeOf("function");
      expect(source.fork).toBeTypeOf("function");

      const written = await source.exec(`printf %s ${marker} > /home/node/workspace/marker.txt`);
      expect(written.exitCode).toBe(0);

      const checkpoint = await source.checkpoint!({ name: `ckpt-${marker}` });
      expect(checkpoint.provider).toBe("docker-box");
      expect(typeof checkpoint.id).toBe("string");

      forked = await source.fork!(checkpoint, { name: `fork-${marker}` });
      expect(forked.id).not.toBe(source.id);

      const read = await forked.exec("cat /home/node/workspace/marker.txt");
      expect(read.exitCode).toBe(0);
      expect(read.stdout).toBe(marker);

      // The fork is independent: new writes never reach the source.
      const forkWrite = await forked.exec(`printf %s fork > /home/node/workspace/after-fork.txt`);
      expect(forkWrite.exitCode).toBe(0);
      const sourceRead = await source.exec("cat /home/node/workspace/after-fork.txt 2>/dev/null; printf x");
      expect(sourceRead.stdout).toBe("x");
    } finally {
      await forked?.destroy?.().catch(() => undefined);
      await source?.destroy?.().catch(() => undefined);
    }
  });

  it("refuses a foreign provider's checkpoint", async () => {
    const image = process.env.CLI_BRIDGE_BOX_IMAGE ?? "";
    if (image === "") return;
    const provider = createBridgeSandboxProvider({
      vendor: dockerBoxVendor(image),
      router: { key: "unused" },
    });
    let source: AgentEnvironment | undefined;
    try {
      source = await provider.create({ profile: { name: "foreign-refusal", harness: "claude-code" } });
      await expect(
        source.fork!({ id: "some-e2b-snapshot", provider: "e2b" }),
      ).rejects.toThrow(/cannot restore on docker-box/);
    } finally {
      await source?.destroy?.().catch(() => undefined);
    }
  });
});

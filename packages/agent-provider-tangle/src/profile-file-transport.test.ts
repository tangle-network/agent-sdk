import { describe, expect, it, vi } from "vitest";
import type { AgentProfile } from "@tangle-network/agent-interface";
import type { CreateSandboxOptions } from "@tangle-network/sandbox";
import { createTangleProvider, type SandboxInstanceLike } from "./index.js";
import { assertMappedCreateOptions } from "./tangle-create-options.js";
import { MAX_ARRAY_LENGTH, MAX_STRING_LENGTH } from "./tangle-contract-safety.js";
import { promptOptionsFromTurnInput } from "./tangle-prompt.js";

const recordedFileLengths = [41_336, 17_524, 229_349, 22_825, 16_770];
function profileWithSourceFiles(): AgentProfile {
  return {
    name: "product-director",
    harness: "opencode",
    resources: {
      files: recordedFileLengths.map((length, index) => ({
        path: `product/source-${index}.txt`,
        resource: { kind: "inline", name: `source-${index}`, content: "x".repeat(length) },
      })),
    },
  };
}

function fixture() {
  const box: SandboxInstanceLike = { id: "source-files", status: "running", async *streamPrompt() {} };
  const create = vi.fn(async (_options?: CreateSandboxOptions) => box);
  return { create, provider: createTangleProvider({ client: { create } }) };
}

describe("inline profile files use the SDK file transport", () => {
  it("passes recorded large file sizes unchanged through every default create check", async () => {
    const { create, provider } = fixture();
    const profile = profileWithSourceFiles();
    const original = structuredClone(profile);
    const input = { profile, idempotencyKey: "large-source-files" };
    await provider.create(input);
    await provider.create(input);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]?.backend?.profile).toEqual(original);
    expect(profile).toEqual(original);
    const changed = structuredClone(profile);
    changed.resources!.files![0].resource = { kind: "inline", name: "changed", content: "y".repeat(41_336) };
    await expect(provider.create({ ...input, profile: changed })).rejects.toThrow(/conflicts/);
    expect(create).toHaveBeenCalledOnce();
  });

  it("preserves the same file bytes on a per-turn profile", () => {
    const profile = profileWithSourceFiles();
    const options = promptOptionsFromTurnInput({ prompt: "continue", providerOptions: { backend: { profile } } }, {
      provider: "tangle-sandbox", environmentId: "source-files",
    });
    expect(options.backend?.profile).toEqual(profile);
  });

  it("validates large files introduced by a custom create mapper", async () => {
    const { create } = fixture();
    const profile = profileWithSourceFiles();
    const provider = createTangleProvider({ client: { create }, mapCreateInput: () => ({ backend: { profile } }) });
    await provider.create({ profile: { name: "mapped" } });
    expect(create.mock.calls[0]?.[0]?.backend?.profile).toEqual(profile);
    expect(() => assertMappedCreateOptions({ backend: { profile }, autoMaterializeProfileFiles: false })).toThrow(/JSON bound/);
  });

  it.each(["metadata", "env", "prompt", "name"] as const)("keeps %s strings bounded before SDK create", async (field) => {
    const { create, provider } = fixture();
    const profile = profileWithSourceFiles();
    const oversized = "x".repeat(MAX_STRING_LENGTH + 1);
    const input = field === "metadata" ? { profile, metadata: { value: oversized } }
      : field === "env" ? { profile, env: { VALUE: oversized } }
      : field === "prompt" ? { profile: { ...profile, prompt: { instructions: [oversized] } } }
      : { profile: { ...profile, resources: { files: [{ path: "file", resource: { kind: "inline" as const, name: oversized, content: oversized } }] } } };
    await expect(provider.create(input)).rejects.toThrow(/JSON bound/);
    expect(create).not.toHaveBeenCalled();
  });

  it("does not exempt unrelated mapped fields with a content-shaped key", () => {
    const profile = profileWithSourceFiles();
    expect(() => assertMappedCreateOptions({ backend: { profile }, metadata: { "backend.profile.resources.files[0].resource.content": "x".repeat(MAX_STRING_LENGTH + 1) } })).toThrow(/JSON bound/);
  });

  it("rejects traversal before SDK create even when best-effort resource handling was requested", async () => {
    const { create, provider } = fixture();
    const profile = profileWithSourceFiles();
    profile.resources!.failOnError = false;
    profile.resources!.files![0].path = "../escape.txt";
    await expect(provider.create({ profile })).rejects.toThrow(/unsafe.*path/);
    expect(create).not.toHaveBeenCalled();
  });

  it("retains the file collection bound", async () => {
    const { create, provider } = fixture();
    const file = profileWithSourceFiles().resources!.files![0];
    await expect(provider.create({ profile: { resources: { files: Array.from({ length: MAX_ARRAY_LENGTH + 1 }, () => file) } } })).rejects.toThrow(/MAX_ARRAY_LENGTH/);
    expect(create).not.toHaveBeenCalled();
  });

  it("bounds unknown-key diagnostics before schema parsing", async () => {
    const { create, provider } = fixture();
    const profile = profileWithSourceFiles();
    Object.assign(profile.resources!.files![0], { ["private".repeat(3000)]: true });
    let failure: unknown;
    try { await provider.create({ profile }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toContain("MAX_IDENTIFIER_LENGTH");
    expect(message.length).toBeLessThanOrEqual(512);
    expect(message).not.toContain("private");
    expect(create).not.toHaveBeenCalled();
  });
});

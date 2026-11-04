import { describe, expect, it } from "vitest";
import { Sandbox } from "@tangle-network/sandbox";
import { createTangleProvider } from "./tangle-provider.js";

/** The real Sandbox SDK check, reached through the provider's public validateProfile. */
describe("Tangle profile validation", () => {
  const provider = createTangleProvider({ client: new Sandbox({ apiKey: "sk-tan-validation-only", baseUrl: "http://127.0.0.1:9" }) });
  const mount = (path: string, content: unknown = "x") => ({
    name: "validation",
    resources: { files: [{ path, resource: { kind: "inline", content } }] },
  }) as never;

  it("refuses a mount the Sandbox would refuse at create, before any box exists", async () => {
    const result = await provider.validateProfile!(mount("../escape.c"));
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([expect.objectContaining({ level: "error", message: expect.stringContaining("../escape.c") })]);
    expect((await provider.validateProfile!(mount("~/notes.c", 7))).ok).toBe(false);
  });

  it("accepts valid mounts and profiles without inline files", async () => {
    expect(await provider.validateProfile!(mount("~/work/count.c"))).toEqual({ ok: true, issues: [] });
    expect(await provider.validateProfile!({ name: "plain" } as never)).toEqual({ ok: true, issues: [] });
    expect(await provider.validateProfile!("profile-ref")).toEqual({ ok: true, issues: [] });
  });

  it("keeps a caller-supplied validator's issues alongside the mount check", async () => {
    const custom = createTangleProvider({
      client: new Sandbox({ apiKey: "sk-tan-validation-only", baseUrl: "http://127.0.0.1:9" }),
      validateProfile: () => ({ ok: false, issues: [{ level: "error", code: "CALLER", message: "caller refusal" }] }),
    });
    const result = await custom.validateProfile!(mount("../escape.c"));
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(["PROFILE_FILE_MOUNT_INVALID", "CALLER"]);
  });

  it("refuses a codex reader that asks for no tools before any box exists (tangle-engine-20261104a s3:s6)", async () => {
    const reader = {
      name: "reader-rc1-update-outcome-1",
      harness: "codex",
      prompt: { systemPrompt: "Read the outcome and report it." },
      tools: { exec_command: false },
      permissions: { bash: "deny", edit: "deny" },
    } as never;
    const result = await provider.validateProfile!(reader);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([expect.objectContaining({ level: "error", code: "PROFILE_UNSUPPORTED" })]);
  });
});


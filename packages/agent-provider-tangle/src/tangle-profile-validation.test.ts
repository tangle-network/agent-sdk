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
});

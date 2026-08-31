import { describe, expect, it } from "vitest";
import {
  MAX_WORKSPACE_CWD_LENGTH,
  WorkspaceRequestSchema,
  canonicalWorkspaceCwd,
  workspaceCwdSchema,
} from "./environment-provider.js";
import { CONTRACT_MAX_STRING_LENGTH } from "./contract-limits.js";

describe("WorkspaceRequestSchema", () => {
  it("preserves every supported field", () => {
    const request = {
      environment: "universal",
      repoUrl: "https://example.com/repo.git",
      gitRef: "feature/workspace",
      cwd: "workspace",
      providerOptions: { region: "us-east", retries: 2 },
    };

    expect(WorkspaceRequestSchema.parse(request)).toEqual(request);
    expect(
      WorkspaceRequestSchema.parse({ image: "node:22", cwd: "." }),
    ).toEqual({ image: "node:22", cwd: "." });
    expect(WorkspaceRequestSchema.parse({})).toEqual({});
  });

  it("rejects unknown, empty, and unbounded fields", () => {
    expect(() => WorkspaceRequestSchema.parse({ unknown: true })).toThrow();
    for (const field of ["image", "repoUrl", "cwd"] as const) {
      expect(() => WorkspaceRequestSchema.parse({ [field]: "" })).toThrow();
    }
    expect(() => WorkspaceRequestSchema.parse({ environment: " " })).toThrow();
    expect(() => WorkspaceRequestSchema.parse({ gitRef: "main" })).toThrow();
    expect(() =>
      WorkspaceRequestSchema.parse({
        image: "x".repeat(CONTRACT_MAX_STRING_LENGTH + 1),
      }),
    ).toThrow();
  });

  it("canonicalizes portable workspace cwd values", () => {
    expect(workspaceCwdSchema.parse(".")).toBe(".");
    expect(workspaceCwdSchema.parse("./packages/braid")).toBe("packages/braid");
    expect(workspaceCwdSchema.parse("packages//braid/.")).toBe("packages/braid");
    expect(canonicalWorkspaceCwd("./packages//braid/.")).toBe("packages/braid");
    expect(WorkspaceRequestSchema.parse({ cwd: "./packages//braid/." })).toEqual({
      cwd: "packages/braid",
    });
  });

  it.each([
    ["/workspace/src", "Workspace cwd must be relative"],
    ["../outside", "Workspace cwd cannot leave the workspace root"],
    ["src/../../outside", "Workspace cwd cannot leave the workspace root"],
    ["src\\win", "Workspace cwd must use POSIX separators"],
    ["src\u0000bad", "Workspace cwd cannot contain control characters"],
  ])("rejects non-portable cwd %j", (cwd, message) => {
    expect(() => workspaceCwdSchema.parse(cwd)).toThrow(message);
    expect(() => WorkspaceRequestSchema.parse({ cwd })).toThrow(message);
  });

  it("rejects an empty cwd", () => {
    expect(() => workspaceCwdSchema.parse("")).toThrow();
    expect(() => WorkspaceRequestSchema.parse({ cwd: "" })).toThrow();
  });

  it("enforces the portable cwd length bound", () => {
    const cwd = "a".repeat(MAX_WORKSPACE_CWD_LENGTH + 1);
    expect(() => workspaceCwdSchema.parse(cwd)).toThrow();
    expect(() => WorkspaceRequestSchema.parse({ cwd })).toThrow();
  });

  it("rejects provider-invalid combinations", () => {
    expect(() =>
      WorkspaceRequestSchema.parse({ environment: "universal", image: "node:22" }),
    ).toThrow(/both environment and image/);
    expect(() =>
      WorkspaceRequestSchema.parse({ gitRef: "main" }),
    ).toThrow(/gitRef requires repoUrl/);
  });

  it("bounds provider options as a JSON record", () => {
    expect(() =>
      WorkspaceRequestSchema.parse({ providerOptions: { value: 1 / 0 } }),
    ).toThrow();
    expect(() =>
      WorkspaceRequestSchema.parse({ providerOptions: [] }),
    ).toThrow();
  });
});

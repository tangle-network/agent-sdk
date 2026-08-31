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
      cwd: { base: "repository", path: "workspace" },
      providerOptions: { region: "us-east", retries: 2 },
    };

    expect(WorkspaceRequestSchema.parse(request)).toEqual(request);
    expect(
      WorkspaceRequestSchema.parse({
        image: "node:22",
        cwd: { base: "repository", path: "." },
      }),
    ).toEqual({
      image: "node:22",
      cwd: { base: "repository", path: "." },
    });
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
    expect(workspaceCwdSchema.parse({ base: "repository", path: "." })).toEqual({
      base: "repository",
      path: ".",
    });
    expect(
      workspaceCwdSchema.parse({ base: "repository", path: "./packages/braid" }),
    ).toEqual({ base: "repository", path: "packages/braid" });
    expect(
      workspaceCwdSchema.parse({ base: "repository", path: "packages//braid/." }),
    ).toEqual({ base: "repository", path: "packages/braid" });
    expect(canonicalWorkspaceCwd({ base: "repository", path: "./packages//braid/." })).toEqual({
      base: "repository",
      path: "packages/braid",
    });
    expect(WorkspaceRequestSchema.parse({
      cwd: { base: "repository", path: "./packages//braid/." },
    })).toEqual({
      cwd: { base: "repository", path: "packages/braid" },
    });
  });

  it.each([
    ["/workspace/src", "Workspace cwd must be relative"],
    ["../outside", "Workspace cwd cannot leave the workspace root"],
    ["src/../../outside", "Workspace cwd cannot leave the workspace root"],
    ["C:/workspace", "Workspace cwd must be relative"],
    ["src\\win", "Workspace cwd must use POSIX separators"],
    ["src\u0000bad", "Workspace cwd cannot contain control characters"],
    ["\ud800", "Workspace cwd must contain well-formed Unicode"],
  ])("rejects non-portable cwd %j", (cwd, message) => {
    const value = { base: "repository", path: cwd } as const;
    expect(() => workspaceCwdSchema.parse(value)).toThrow(message);
    expect(() => WorkspaceRequestSchema.parse({ cwd: value })).toThrow(message);
  });

  it("rejects an empty cwd", () => {
    const value = { base: "repository", path: "" } as const;
    expect(() => workspaceCwdSchema.parse(value)).toThrow();
    expect(() => WorkspaceRequestSchema.parse({ cwd: value })).toThrow();
  });

  it("enforces the portable cwd length bound", () => {
    const cwd = "a".repeat(MAX_WORKSPACE_CWD_LENGTH + 1);
    const value = { base: "repository", path: cwd } as const;
    expect(() => workspaceCwdSchema.parse(value)).toThrow();
    expect(() => WorkspaceRequestSchema.parse({ cwd: value })).toThrow();
  });

  it("preserves explicitly based native host paths", () => {
    expect(workspaceCwdSchema.parse({ base: "host", path: "/workspace" })).toEqual({
      base: "host",
      path: "/workspace",
    });
    expect(workspaceCwdSchema.parse({ base: "host", path: "" })).toEqual({
      base: "host",
      path: "",
    });
    expect(workspaceCwdSchema.parse({ base: "host", path: "C:\\workspace" })).toEqual({
      base: "host",
      path: "C:\\workspace",
    });
    expect(() => workspaceCwdSchema.parse({ base: "host", path: "bad\u0000path" })).toThrow(
      "Workspace cwd cannot contain control characters",
    );
  });

  it("rejects an unbased cwd string instead of inferring its provider", () => {
    expect(() => workspaceCwdSchema.parse("/workspace")).toThrow();
    expect(() => WorkspaceRequestSchema.parse({ cwd: "/workspace" })).toThrow();
  });

  it("rejects an unknown cwd base or extra path field", () => {
    expect(() => workspaceCwdSchema.parse({ base: "connection", path: "/workspace" })).toThrow();
    expect(() => workspaceCwdSchema.parse({ base: "host", path: "/workspace", extra: true })).toThrow();
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

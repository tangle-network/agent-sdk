import { describe, expect, it } from "vitest";
import { WorkspaceRequestSchema } from "./environment-provider.js";
import { CONTRACT_MAX_STRING_LENGTH } from "./contract-limits.js";

describe("WorkspaceRequestSchema", () => {
  it("preserves every supported field", () => {
    const request = {
      environment: "universal",
      repoUrl: "https://example.com/repo.git",
      gitRef: "feature/workspace",
      cwd: "/workspace",
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

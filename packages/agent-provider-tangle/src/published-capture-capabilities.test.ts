import { afterEach, expect, it, vi } from "vitest";
import { Sandbox, SandboxInstance } from "@tangle-network/sandbox";

afterEach(() => vi.restoreAllMocks());

it("preserves protocol and harness capture through the published Sandbox capability parser", async () => {
  const client = new Sandbox({ apiKey: "parser-fixture", baseUrl: "https://sandbox.example" });
  const info = {
    id: "parser-box", status: "running" as const, createdAt: new Date(0),
    filesystemIncarnationId: "parser-incarnation",
    filesystemIncarnationProvenance: "fresh" as const,
    filesystemIncarnationReadiness: "ready" as const,
  };
  const wire = {
    schema: 1, nativeSessionCaptureVersion: 2, nativeSessionCaptureHarnesses: ["opencode", "claude-code"],
    agentInterface: "2.15.0", sidecarVersion: "fixture", image: "fixture-image",
    dispatch: { runControlRef: true, executionIdOnAdmission: true },
    cancel: { canonicalRunCancellation: true, digestBound: true, idempotent: true },
    runs: { executionScopedStatus: true, eventReplay: true }, interactions: {},
  };
  const reads: string[] = [];
  vi.spyOn(client, "fetch").mockImplementation(async (path) => {
    reads.push(path);
    if (path === "/v1/sandboxes/parser-box") return Response.json(info);
    if (path === "/v1/sandboxes/parser-box/runtime/capabilities") return Response.json(wire);
    throw new Error("Unexpected SDK request " + path);
  });
  const box = new SandboxInstance(client, info);
  await expect(box.capabilities()).resolves.toMatchObject({
    schema: 1, nativeSessionCaptureVersion: 2, nativeSessionCaptureHarnesses: ["opencode", "claude-code"],
  });
  expect(reads).toContain("/v1/sandboxes/parser-box/runtime/capabilities");
  expect(reads.some((path) => path.includes("evidence-capabilities"))).toBe(false);
});

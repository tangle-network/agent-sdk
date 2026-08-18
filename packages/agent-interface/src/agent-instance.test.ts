import { describe, expect, expectTypeOf, it } from "vitest";
import {
  agentInstanceRecordSchema,
  agentInstanceSpecSchema,
  agentInstanceStopAcknowledgementSchema,
  type AgentInstanceRecord,
  type AgentInstanceSpec,
} from "./agent-instance.js";

describe("agent instance contracts", () => {
  it("accepts a profile-less Agent", () => {
    expect(
      agentInstanceSpecSchema.parse({
        id: "default",
        workspace: { mode: "shared" },
      }),
    ).toEqual({
      id: "default",
      workspace: { mode: "shared" },
    });
  });

  it("accepts an inline profile, harness override, and isolated workspace", () => {
    const spec = {
      id: "reviewer",
      profile: {
        name: "reviewer",
        harness: "opencode",
        prompt: { appendSystemPrompt: "Review every claim." },
      },
      harness: "claude-code",
      workspace: { mode: "isolated" },
    } satisfies AgentInstanceSpec;

    expect(agentInstanceSpecSchema.parse(spec)).toMatchObject({
      id: "reviewer",
      profile: { name: "reviewer", harness: "opencode" },
      harness: "claude-code",
      workspace: { mode: "isolated" },
    });
    expectTypeOf(spec).toMatchTypeOf<AgentInstanceSpec>();
  });

  it("rejects provider and machine fields outside the portable contract", () => {
    expect(() =>
      agentInstanceSpecSchema.parse({
        id: "planner",
        machineShape: "profile-specific-vm",
      }),
    ).toThrow();

    expect(() =>
      agentInstanceSpecSchema.parse({
        id: "planner",
        metadata: { apiKey: "secret" },
      }),
    ).toThrow();
  });

  it("publishes only credential-free profile identity", () => {
    const record = agentInstanceRecordSchema.parse({
      kind: "agent-instance",
      schemaVersion: 1,
      id: "planner",
      profile: {
        name: "planner",
        digest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      workspace: { mode: "shared" },
      status: "ready",
      createdAtMs: 10,
      updatedAtMs: 11,
    });

    expect(record.profile).toEqual({
      name: "planner",
      digest:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });

  it("requires failure evidence only for failed records", () => {
    const base = {
      kind: "agent-instance" as const,
      schemaVersion: 1 as const,
      id: "reviewer",
      workspace: { mode: "shared" as const },
      createdAtMs: 10,
      updatedAtMs: 11,
    };

    expect(() =>
      agentInstanceRecordSchema.parse({ ...base, status: "failed" }),
    ).toThrow(/failure reason/u);

    expect(() =>
      agentInstanceRecordSchema.parse({
        ...base,
        status: "ready",
        failure: { message: "not valid here" },
      }),
    ).toThrow(/only for failed/u);

    const failed = agentInstanceRecordSchema.parse({
      ...base,
      status: "failed",
      failure: { code: "HARNESS_EXITED", message: "process exited" },
    });
    expectTypeOf(failed).toMatchTypeOf<AgentInstanceRecord>();
  });

  it("rejects reversed timestamps and control characters", () => {
    expect(() =>
      agentInstanceRecordSchema.parse({
        kind: "agent-instance",
        schemaVersion: 1,
        id: "planner",
        name: "bad\nname",
        workspace: { mode: "shared" },
        status: "ready",
        createdAtMs: 20,
        updatedAtMs: 10,
      }),
    ).toThrow();
  });

  it("parses idempotent stop outcomes", () => {
    expect(
      agentInstanceStopAcknowledgementSchema.parse({
        agentId: "planner",
        outcome: "already-stopped",
      }),
    ).toEqual({ agentId: "planner", outcome: "already-stopped" });
  });
});

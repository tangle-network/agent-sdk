import { describe, expect, it } from "vitest";
import type {
  AgentWorkspaceLeaseRecordMaterial,
  AgentWorkspaceSourceSnapshotPolicy,
  Sha256Digest,
} from "./index.js";
import {
  AGENT_WORKSPACE_LEASE_PHASES,
  agentWorkspaceLeaseRecordSchema,
  buildAgentWorkspaceLeaseRecord,
  canonicalAgentWorkspaceLeaseRecordDigest,
} from "./index.js";

const sha = (digit: string): Sha256Digest =>
  `sha256:${digit.repeat(64)}` as Sha256Digest;

const policy: AgentWorkspaceSourceSnapshotPolicy = {
  kind: "provider-declared",
  name: "agent-runtime/local-private-workspace-source",
  version: 1,
  digest: sha("1"),
};

function base() {
  return {
    kind: "agent-workspace-lease" as const,
    schemaVersion: 1 as const,
    leaseId: "local-workspace.lease-1",
    ownerId: "discovery-run-1",
    workspace: {
      provider: "agent-runtime/local-private-workspace",
      root: "/private/workspaces/allocation-1",
      identityDigest: sha("2"),
    },
    isolation: "per-run" as const,
    sourceSnapshotDigest: sha("3"),
    sourceSnapshotPolicy: policy,
    createdAtMs: 100,
    updatedAtMs: 200,
    expiresAtMs: 2_000,
  };
}

function material(
  phase: (typeof AGENT_WORKSPACE_LEASE_PHASES)[number],
): AgentWorkspaceLeaseRecordMaterial {
  if (phase === "copy-ready") {
    return { ...base(), phase, cleanupAttempts: 0 };
  }
  if (phase === "workspace-sealed") {
    return {
      ...base(),
      phase,
      preparedWorkspaceDigest: sha("4"),
      profileActivationDigest: sha("5"),
      cleanupAttempts: 0,
    };
  }
  if (phase === "execution-bound") {
    return {
      ...base(),
      phase,
      preparedWorkspaceDigest: sha("4"),
      profileActivationDigest: sha("5"),
      executionPreparationDigest: sha("6"),
      cleanupAttempts: 0,
    };
  }
  const cleanupEvidence = {
    preparedWorkspaceDigest: sha("4"),
    profileActivationDigest: sha("5"),
    executionPreparationDigest: sha("6"),
    cleanupAttempts: 1,
  };
  if (phase === "destroying") {
    return { ...base(), ...cleanupEvidence, phase };
  }
  if (phase === "cleanup-failed") {
    return {
      ...base(),
      ...cleanupEvidence,
      phase,
      cleanupError: "recursive removal returned while files remained",
    };
  }
  return { ...base(), ...cleanupEvidence, phase: "destroyed" };
}

describe("AgentWorkspaceLeaseRecord", () => {
  it("self-hashes every phase-valid public lifecycle projection", () => {
    for (const phase of AGENT_WORKSPACE_LEASE_PHASES) {
      const input = material(phase);
      const record = buildAgentWorkspaceLeaseRecord(input);

      expect(agentWorkspaceLeaseRecordSchema.parse(record)).toEqual(record);
      expect(record.digest).toBe(
        canonicalAgentWorkspaceLeaseRecordDigest(input),
      );
      expect(record.phase).toBe(phase);
      expect(record).not.toHaveProperty("ownerToken");
      expect(record).not.toHaveProperty("ownerTokenDigest");
    }
  });

  it("requires the exact evidence implied by each active phase", () => {
    const invalid = [
      { ...material("copy-ready"), preparedWorkspaceDigest: sha("4") },
      {
        ...material("workspace-sealed"),
        profileActivationDigest: undefined,
      },
      {
        ...material("workspace-sealed"),
        executionPreparationDigest: sha("6"),
      },
      {
        ...material("execution-bound"),
        executionPreparationDigest: undefined,
      },
      { ...material("execution-bound"), cleanupAttempts: 1 },
    ];

    for (const value of invalid) {
      expect(() =>
        buildAgentWorkspaceLeaseRecord(
          value as unknown as AgentWorkspaceLeaseRecordMaterial,
        ),
      ).toThrow();
    }
  });

  it("allows cleanup after any prior evidence stage but rejects partial evidence", () => {
    for (const evidence of [
      {},
      {
        preparedWorkspaceDigest: sha("4"),
        profileActivationDigest: sha("5"),
      },
      {
        preparedWorkspaceDigest: sha("4"),
        profileActivationDigest: sha("5"),
        executionPreparationDigest: sha("6"),
      },
    ]) {
      expect(() =>
        buildAgentWorkspaceLeaseRecord({
          ...base(),
          ...evidence,
          phase: "destroying",
          cleanupAttempts: 1,
        }),
      ).not.toThrow();
    }

    expect(() =>
      buildAgentWorkspaceLeaseRecord({
        ...base(),
        phase: "destroying",
        preparedWorkspaceDigest: sha("4"),
        cleanupAttempts: 1,
      } as unknown as AgentWorkspaceLeaseRecordMaterial),
    ).toThrow(/must appear together/);
  });

  it("binds provider, isolation, snapshot policy, and content as distinct identities", () => {
    const original = buildAgentWorkspaceLeaseRecord(material("workspace-sealed"));
    const changedPolicy = buildAgentWorkspaceLeaseRecord({
      ...material("workspace-sealed"),
      sourceSnapshotPolicy: { ...policy, version: 2 },
    });
    const changedProvider = buildAgentWorkspaceLeaseRecord({
      ...material("workspace-sealed"),
      workspace: { ...base().workspace, provider: "sandbox/remote" },
    });
    const changedIsolation = buildAgentWorkspaceLeaseRecord({
      ...material("workspace-sealed"),
      isolation: "shared",
    });

    expect(
      new Set([
        original.digest,
        changedPolicy.digest,
        changedProvider.digest,
        changedIsolation.digest,
      ]).size,
    ).toBe(4);
    expect(original.workspace.identityDigest).not.toBe(
      original.sourceSnapshotDigest,
    );
    expect(original.sourceSnapshotDigest).not.toBe(
      original.preparedWorkspaceDigest,
    );
  });

  it("rejects tampering, private fields, invalid time, and unsanitized cleanup errors", () => {
    const record = buildAgentWorkspaceLeaseRecord(material("execution-bound"));
    const invalid = [
      { ...record, ownerToken: "private-capability" },
      { ...record, ownerTokenDigest: sha("9") },
      { ...record, expiresAtMs: record.createdAtMs },
      { ...record, updatedAtMs: record.createdAtMs - 1 },
      { ...record, cleanupError: undefined },
      { ...record, ownerId: "   " },
      {
        ...record,
        workspace: {
          ...record.workspace,
          root: "https://user:password@workspace.example.test",
        },
      },
      {
        ...buildAgentWorkspaceLeaseRecord(material("cleanup-failed")),
        cleanupError: "authorization failed: Bearer private-value",
      },
    ];

    for (const value of invalid) {
      expect(agentWorkspaceLeaseRecordSchema.safeParse(value).success).toBe(
        false,
      );
    }
    expect(
      agentWorkspaceLeaseRecordSchema.safeParse({
        ...record,
        workspace: { ...record.workspace, root: "/different/root" },
      }).success,
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  canonicalCandidateDigest,
  confidentialExecutionRequestDigest,
  sha256Bytes,
  workspaceCheckpointRequestDigest,
  workspaceForkRequestDigest,
} from "@tangle-network/agent-interface";
import type {
  WorkspaceCheckpointRequest,
  WorkspaceCheckpointRef,
  WorkspaceForkRequest,
} from "@tangle-network/agent-interface";
import { runWorkspaceBranchingConformance } from "@tangle-network/agent-provider-testkit";
import {
  createTangleWorkspaceBranching,
  supportsConfidentialAttestation,
  supportsWorkspaceBranching,
  tangleWorkspaceConfidentialityVerified,
} from "./tangle-workspace-branching.js";
import { createTangleProvider } from "./tangle-provider.js";
import type {
  SandboxClientLike,
  SandboxInstanceLike,
} from "./tangle-types.js";

const provider = "tangle-sandbox";
const sourceEnvironmentId = "sandbox-parent";
const source = {
  runId: "run-parent",
  provider,
  environmentId: sourceEnvironmentId,
  sessionId: "session-parent",
  executionId: "execution-parent",
  requestDigest: canonicalCandidateDigest({ request: "parent" }),
} as const;

function createFakeSandbox(): {
  box: SandboxInstanceLike;
  client: SandboxClientLike;
} {
  const snapshots: Array<{
    snapshotId: string;
    sandboxId: string;
    createdAt: Date;
    tags: string[];
  }> = [];
  const children = new Map<string, SandboxInstanceLike>();
  const checkpointKeys = new Map<string, string>();
  const forkKeys = new Map<string, string>();
  let snapshotNumber = 0;
  let childNumber = 0;

  const box: SandboxInstanceLike = {
    id: sourceEnvironmentId,
    status: "running",
    async *streamPrompt() {},
    async snapshot(options) {
      const key = options?.idempotencyKey ?? "without-key";
      const digest = canonicalCandidateDigest(options?.tags ?? []);
      const previousDigest = checkpointKeys.get(key);
      if (previousDigest !== undefined) {
        const snapshot = snapshots.find((item) => item.tags.includes(`server:${key}`));
        if (!snapshot) throw new Error("snapshot ledger lost its resource");
        return {
          snapshotId: snapshot.snapshotId,
          createdAt: snapshot.createdAt,
          tags: snapshot.tags,
          idempotency: {
            outcome: previousDigest === digest ? ("replayed" as const) : ("replayed" as const),
            requestDigest: previousDigest,
          },
        };
      }
      checkpointKeys.set(key, digest);
      const snapshot = {
        snapshotId: `checkpoint-${++snapshotNumber}`,
        sandboxId: sourceEnvironmentId,
        createdAt: new Date("2026-08-28T00:00:00.000Z"),
        tags: [...(options?.tags ?? []), `server:${key}`],
      };
      snapshots.push(snapshot);
      return {
        ...snapshot,
        idempotency: { outcome: "created" as const, requestDigest: digest },
      };
    },
    async listSnapshots() {
      return snapshots;
    },
    async deleteSnapshot(snapshotId) {
      const index = snapshots.findIndex((item) => item.snapshotId === snapshotId);
      if (index < 0) return { snapshotId, outcome: "already_absent" as const };
      snapshots.splice(index, 1);
      return { snapshotId, outcome: "deleted" as const };
    },
    async getSnapshotOperation(idempotencyKey) {
      if (!checkpointKeys.has(idempotencyKey)) {
        return { outcome: "not_found" as const, kind: "checkpoint" as const };
      }
      return {
        outcome: "found" as const,
        kind: "checkpoint" as const,
        state: "succeeded" as const,
      };
    },
    async fork(_count, options) {
      const key = options?.idempotencyKey ?? "without-key";
      const digest = canonicalCandidateDigest(options?.metadata ?? {});
      const previousDigest = forkKeys.get(key);
      if (previousDigest !== undefined) {
        const child = [...children.values()].find(
          (item) => item.metadata?.serverForkKey === key,
        );
        if (!child) throw new Error("fork ledger lost its child");
        return {
          children: [child],
          requestedCount: 1,
          materializedCount: 1,
          complete: true,
          idempotency: {
            outcome: previousDigest === digest ? ("replayed" as const) : ("replayed" as const),
            requestDigest: previousDigest,
          },
        };
      }
      forkKeys.set(key, digest);
      const childId = `fork-${++childNumber}`;
      const child: SandboxInstanceLike = {
        id: childId,
        createdAt: new Date("2026-08-28T00:00:01.000Z"),
        metadata: { ...(options?.metadata ?? {}), serverForkKey: key },
        async *streamPrompt() {},
        async delete() {
          children.delete(childId);
          return { sandboxId: childId, outcome: "destroyed" as const };
        },
      };
      children.set(childId, child);
      return {
        children: [child],
        requestedCount: 1,
        materializedCount: 1,
        complete: true,
        idempotency: { outcome: "created" as const, requestDigest: digest },
      };
    },
    async getForkOperation(idempotencyKey) {
      return forkKeys.has(idempotencyKey)
        ? { outcome: "found" as const, kind: "fork" as const, state: "succeeded" as const }
        : { outcome: "not_found" as const, kind: "fork" as const };
    },
  };

  const client: SandboxClientLike = {
    create: async () => box,
    async list() {
      return [...children.values()];
    },
    async get(id) {
      return id === sourceEnvironmentId ? box : children.get(id) ?? null;
    },
  };
  return { box, client };
}

function checkpointRequest(): WorkspaceCheckpointRequest {
  const material = { source, name: "before-analysis", metadata: { suite: "provider" } };
  return {
    ...material,
    idempotencyKey: "checkpoint-operation",
    requestDigest: workspaceCheckpointRequestDigest(material),
  };
}

function forkRequest(checkpoint: WorkspaceCheckpointRef): WorkspaceForkRequest {
  const material = {
    checkpoint,
    name: "parallel-worker",
    metadata: { lane: "analysis" },
    placement: { kind: "sandbox", sandboxId: "fork-placement" } as const,
  };
  return {
    ...material,
    idempotencyKey: "fork-operation",
    requestDigest: workspaceForkRequestDigest(material),
  };
}

describe("Tangle workspace branching", () => {
  it("requires the complete managed operation surface", () => {
    const { box, client } = createFakeSandbox();
    expect(supportsWorkspaceBranching(box, client)).toBe(true);
    expect(
      supportsWorkspaceBranching(
        { id: sourceEnvironmentId, async *streamPrompt() {} },
        client,
      ),
    ).toBe(false);
    expect(supportsConfidentialAttestation(box)).toBe(false);
  });

  it("passes exact checkpoint, fork, recovery, conflict, and cleanup conformance", async () => {
    const { box, client } = createFakeSandbox();
    const operations = createTangleWorkspaceBranching({ box, client, provider });
    expect(operations).toBeDefined();
    const result = await runWorkspaceBranchingConformance({
      name: "fake Sandbox",
      operations: operations!,
      checkpointRequest: checkpointRequest(),
      forkRequest: (checkpoint) => forkRequest(checkpoint),
    });
    expect(result.checked).toContain("confirmed-cleanup");
  });

  it("does not create a checkpoint when inventory returns a malformed value", async () => {
    const { box, client } = createFakeSandbox();
    const snapshot = box.snapshot;
    let snapshotCalls = 0;
    box.listSnapshots = async () => undefined as never;
    box.snapshot = async (options) => {
      snapshotCalls += 1;
      return snapshot!(options);
    };
    const operations = createTangleWorkspaceBranching({ box, client, provider });
    const result = await operations!.checkpoint(checkpointRequest());
    expect(result).toMatchObject({ status: "unknown", retryable: true });
    expect(snapshotCalls).toBe(0);
  });

  it("coalesces concurrent retries with deterministic provider markers", async () => {
    const { box, client } = createFakeSandbox();
    const operations = createTangleWorkspaceBranching({ box, client, provider });
    const request = checkpointRequest();
    const [first, second] = await Promise.all([
      operations!.checkpoint(request),
      operations!.checkpoint(request),
    ]);
    expect([first.status, second.status].sort()).toEqual(["created", "replayed"]);
    if (first.status === "unknown" || first.status === "conflict") {
      throw new Error("first concurrent checkpoint did not succeed");
    }
    if (second.status === "unknown" || second.status === "conflict") {
      throw new Error("second concurrent checkpoint did not succeed");
    }
    expect(first.checkpoint).toEqual(second.checkpoint);
    const forkInput = forkRequest(first.checkpoint);
    const [forkFirst, forkSecond] = await Promise.all([
      operations!.fork(forkInput),
      operations!.fork(forkInput),
    ]);
    expect([forkFirst.status, forkSecond.status].sort()).toEqual([
      "created",
      "replayed",
    ]);
    if (forkFirst.status === "unknown" || forkFirst.status === "conflict") {
      throw new Error("first concurrent fork did not succeed");
    }
    if (forkSecond.status === "unknown" || forkSecond.status === "conflict") {
      throw new Error("second concurrent fork did not succeed");
    }
    expect(forkFirst.environment).toEqual(forkSecond.environment);
  });

  it("recovers operation identity after the provider handle is recreated", async () => {
    const { box, client } = createFakeSandbox();
    const first = createTangleWorkspaceBranching({ box, client, provider });
    const checkpoint = await first!.checkpoint(checkpointRequest());
    expect(checkpoint.status).toBe("created");
    if (checkpoint.status !== "created") throw new Error("checkpoint setup failed");
    const fork = await first!.fork(forkRequest(checkpoint.checkpoint));
    expect(fork.status).toBe("created");
    if (fork.status !== "created") throw new Error("fork setup failed");

    const restarted = createTangleWorkspaceBranching({ box, client, provider });
    const checkpointLookup = await restarted!.lookupCheckpoint({
      idempotencyKey: checkpointRequest().idempotencyKey,
      requestDigest: checkpointRequest().requestDigest,
    });
    expect(checkpointLookup).toMatchObject({ status: "found", checkpoint: checkpoint.checkpoint });
    const forkLookup = await restarted!.lookupFork({
      idempotencyKey: forkRequest(checkpoint.checkpoint).idempotencyKey,
      requestDigest: forkRequest(checkpoint.checkpoint).requestDigest,
    });
    expect(forkLookup).toMatchObject({ status: "found", environment: fork.environment });
  });

  it("reconstructs the source-scoped handle from the provider after restart", async () => {
    const { box, client } = createFakeSandbox();
    const firstProvider = createTangleProvider({ client, name: provider });
    const first = await firstProvider.workspaceBranching?.forEnvironment(
      sourceEnvironmentId,
    );
    expect(first).toBeDefined();
    const checkpoint = await first!.checkpoint(checkpointRequest());
    expect(checkpoint.status).toBe("created");

    const restartedProvider = createTangleProvider({ client, name: provider });
    const restarted =
      await restartedProvider.workspaceBranching?.forEnvironment(
        sourceEnvironmentId,
      );
    expect(restarted).toBeDefined();
    expect(
      await restarted!.lookupCheckpoint({
        idempotencyKey: checkpointRequest().idempotencyKey,
        requestDigest: checkpointRequest().requestDigest,
      }),
    ).toMatchObject({ status: "found" });
    expect(
      await restartedProvider.workspaceBranching?.forEnvironment("missing"),
    ).toBeNull();
    expect(box.id).toBe(sourceEnvironmentId);
  });

  it("fails closed when the TEE nonce or measurement is not trusted", async () => {
    const { box, client } = createFakeSandbox();
    const attestationBox: SandboxInstanceLike = {
      ...box,
      async getTeeAttestation(options) {
        return {
          sandbox_id: "fork-tee",
          attestationNonce: options?.attestationNonce === "wrong" ? "other" : options?.attestationNonce,
          attestation: {
            tee_type: "tdx",
            evidence: [1, 2, 3],
            measurement: [4, 5, 6],
            timestamp: 1_756_368_000,
          },
        };
      },
    };
    expect(supportsConfidentialAttestation(attestationBox, () => null)).toBe(true);
    const verifier = async ({ attestation }: { attestation: { measurement: `sha256:${string}` } }) => ({
      providerKeyId: "provider-key-1",
      providerSignature: "signature-1",
      measurement: attestation.measurement,
    });
    const operations = createTangleWorkspaceBranching({
      box: attestationBox,
      client,
      provider,
      confidentialAttestationVerifier: verifier,
    });
    expect(operations).toBeDefined();
    const requestMaterial = {
      checkpoint: {
        checkpointId: "checkpoint-tee",
        provider,
        source,
        idempotencyKey: "checkpoint-operation",
        requestDigest: workspaceCheckpointRequestDigest({ source }),
        createdAt: "2026-08-28T00:00:00.000Z",
      },
      placement: { kind: "sandbox", sandboxId: sourceEnvironmentId } as const,
      confidential: {
        requested: true as const,
        nonce: "nonce-1",
        policy: "policy-1",
        profileDigest: canonicalCandidateDigest({ profile: "worker" }),
      },
    };
    const request: WorkspaceForkRequest = {
      ...requestMaterial,
      idempotencyKey: "fork-tee",
      requestDigest: workspaceForkRequestDigest(requestMaterial),
    };
    const environment = {
      provider,
      environmentId: "fork-tee",
      sourceEnvironmentId: sourceEnvironmentId,
      source,
      sourceCheckpointId: "checkpoint-tee",
      idempotencyKey: request.idempotencyKey,
      requestDigest: request.requestDigest,
      createdAt: "2026-08-28T00:00:01.000Z",
      placement: request.placement,
      confidentialRequested: true,
    };
    expect(tangleWorkspaceConfidentialityVerified(request, environment, () => false)).toBe(false);
    expect(confidentialExecutionRequestDigest(request.confidential!)).toMatch(/^sha256:/);
  });

  it("returns a confidential claim only after the external verifier accepts the raw quote", async () => {
    const { box, client } = createFakeSandbox();
    const checkpointOperations = createTangleWorkspaceBranching({
      box,
      client,
      provider,
    });
    const checkpoint = await checkpointOperations!.checkpoint(checkpointRequest());
    if (checkpoint.status !== "created") throw new Error("checkpoint setup failed");

    const attestationBox: SandboxInstanceLike = {
      ...box,
      async getTeeAttestation() {
        throw new Error("the parent must not be attested");
      },
    };
    const originalFork = box.fork!;
    attestationBox.fork = async (count, options) => {
      const result = await originalFork(count, options);
      for (const child of result.children) {
        child.getTeeAttestation = async (options) => ({
          sandbox_id: child.id,
          ...(options?.attestationNonce === "nonce-mismatch"
            ? { attestationNonce: "different-nonce" }
            : options?.attestationNonce === undefined
              ? {}
              : { attestationNonce: options.attestationNonce }),
          attestation: {
            tee_type: "tdx",
            evidence: [1, 2, 3],
            measurement: [4, 5, 6],
            timestamp: 1_756_368_000,
          },
        });
      }
      return result;
    };

    const verifier = ({
      report,
      attestation,
    }: {
      report: { measurement: number[] };
      attestation: { nonce: string; measurement: `sha256:${string}` };
    }) => {
      if (attestation.nonce !== "nonce-measurement" && report.measurement[0] === 4) {
        return {
          providerKeyId: "provider-key-1",
          providerSignature: "provider-signature-1",
          measurement: attestation.measurement,
        };
      }
      return {
        providerKeyId: "provider-key-1",
        providerSignature: "provider-signature-1",
        measurement: `sha256:${"f".repeat(64)}` as `sha256:${string}`,
      };
    };
    const operations = createTangleWorkspaceBranching({
      box: attestationBox,
      client,
      provider,
      confidentialAttestationVerifier: verifier,
    });
    const makeRequest = (idempotencyKey: string, nonce: string): WorkspaceForkRequest => {
      const material = {
        checkpoint: checkpoint.checkpoint,
        placement: { kind: "sandbox", sandboxId: sourceEnvironmentId } as const,
        confidential: {
          requested: true as const,
          nonce,
          policy: "policy-1",
          profileDigest: canonicalCandidateDigest({ profile: "worker" }),
        },
      };
      return {
        ...material,
        idempotencyKey,
        requestDigest: workspaceForkRequestDigest(material),
      };
    };

    const acceptedRequest = makeRequest("fork-accepted", "nonce-accepted");
    const accepted = await operations!.fork(acceptedRequest);
    expect(accepted.status).toBe("created");
    if (accepted.status !== "created") throw new Error("accepted fork setup failed");
    expect(accepted.environment.confidentialAttestation).toBeDefined();
    expect(
      tangleWorkspaceConfidentialityVerified(
        acceptedRequest,
        accepted.environment,
        () => true,
      ),
    ).toBe(true);

    const nonceRejected = await operations!.fork(
      makeRequest("fork-rejected-nonce", "nonce-mismatch"),
    );
    expect(nonceRejected.status).toBe("created");
    if (nonceRejected.status !== "created") throw new Error("nonce fork setup failed");
    expect(nonceRejected.environment.confidentialRequested).toBe(true);
    expect(nonceRejected.environment.confidentialAttestation).toBeUndefined();

    const measurementRejected = await operations!.fork(
      makeRequest("fork-rejected-measurement", "nonce-measurement"),
    );
    expect(measurementRejected.status).toBe("created");
    if (measurementRejected.status !== "created") throw new Error("measurement fork setup failed");
    expect(measurementRejected.environment.confidentialAttestation).toBeUndefined();
    expect(sha256Bytes(Uint8Array.from([4, 5, 6]))).toBe(
      accepted.environment.confidentialAttestation?.measurement,
    );
  });
});

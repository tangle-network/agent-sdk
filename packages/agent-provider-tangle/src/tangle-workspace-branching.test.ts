import { describe, expect, it } from "vitest";
import {
  canonicalCandidateDigest,
  confidentialExecutionRequestDigest,
  forkedEnvironmentConfidentialityVerified,
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
  supportsWorkspaceBranching,
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
        const snapshot = snapshots.find((item) =>
          item.tags.includes(
            `server-${canonicalCandidateDigest(key).replace(":", "-")}`,
          ),
        );
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
        tags: [
          ...(options?.tags ?? []),
          `server-${canonicalCandidateDigest(key).replace(":", "-")}`,
        ],
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

  it("keeps every recovery tag within the platform byte bound", async () => {
    const { box, client } = createFakeSandbox();
    const snapshot = box.snapshot!;
    let observedTags: string[] | undefined;
    box.snapshot = async (options) => {
      observedTags = options?.tags;
      return snapshot(options);
    };
    const request = {
      ...checkpointRequest(),
      idempotencyKey: "k".repeat(512),
    };
    const operations = createTangleWorkspaceBranching({ box, client, provider });
    const result = await operations!.checkpoint(request);
    if (result.status !== "created") {
      throw new Error(`long-key checkpoint failed: ${JSON.stringify(result)}`);
    }
    expect(observedTags).toBeDefined();
    expect(
      observedTags!.every(
        (tag) =>
          Buffer.byteLength(tag, "utf8") <= 128 && /^[A-Za-z0-9._-]+$/u.test(tag),
      ),
    ).toBe(true);
  });

  it("recovers checkpoints written with the pre-safe marker format", async () => {
    const { box, client } = createFakeSandbox();
    const request = checkpointRequest();
    const marker = {
      version: 1 as const,
      kind: "checkpoint" as const,
      idempotencyKey: request.idempotencyKey,
      requestDigest: request.requestDigest,
      request,
    };
    const encoded = Buffer.from(JSON.stringify(marker), "utf8").toString("base64url");
    const chunks: string[] = [];
    for (let index = 0; index < encoded.length; index += 240) {
      chunks.push(encoded.slice(index, index + 240));
    }
    const base = "tangle-agent-sdk:workspace:v1:checkpoint";
    const legacyTags = [
      `${base}:key:${Buffer.from(request.idempotencyKey, "utf8").toString("base64url")}`,
      `${base}:digest:${request.requestDigest}`,
      ...chunks.map((chunk, index) => `${base}:material:${index}:${chunks.length}:${chunk}`),
    ];
    const snapshot = {
      snapshotId: "legacy-checkpoint",
      sandboxId: sourceEnvironmentId,
      createdAt: new Date("2026-08-28T00:00:00.000Z"),
      tags: legacyTags,
    };
    box.listSnapshots = async () => [snapshot];
    const observedTags: string[][] = [];
    box.getSnapshotOperation = async (_id, options) => {
      observedTags.push(options?.tags ?? []);
      return options?.tags?.join("|") === legacyTags.join("|")
        ? { outcome: "found" as const, kind: "checkpoint" as const, state: "succeeded" as const }
        : { outcome: "not_found" as const, kind: "checkpoint" as const };
    };

    const operations = createTangleWorkspaceBranching({ box, client, provider });
    const result = await operations!.lookupCheckpoint({
      idempotencyKey: request.idempotencyKey,
      requestDigest: request.requestDigest,
    });
    expect(result).toMatchObject({
      status: "found",
      checkpoint: {
        checkpointId: snapshot.snapshotId,
        provider,
        source,
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
        createdAt: snapshot.createdAt.toISOString(),
      },
    });
    expect(observedTags).toEqual([legacyTags]);
  });

  it("forks a checkpoint immediately when its inventory view still lags", async () => {
    const { box, client } = createFakeSandbox();
    const operations = createTangleWorkspaceBranching({ box, client, provider });
    const checkpoint = await operations!.checkpoint(checkpointRequest());
    if (checkpoint.status !== "created") throw new Error("checkpoint setup failed");
    box.listSnapshots = async () => [];
    await expect(operations!.fork(forkRequest(checkpoint.checkpoint))).resolves.toMatchObject({
      status: "created",
    });
  });

  it("returns a replay after a create commits before transport failure", async () => {
    const { box, client } = createFakeSandbox();
    const snapshot = box.snapshot!;
    let snapshotAttempts = 0;
    box.snapshot = async (options) => {
      const result = await snapshot(options);
      snapshotAttempts += 1;
      if (snapshotAttempts === 1) throw new Error("response lost after commit");
      return result;
    };
    const operations = createTangleWorkspaceBranching({ box, client, provider });
    const checkpoint = await operations!.checkpoint(checkpointRequest());
    expect(checkpoint).toMatchObject({ status: "replayed" });

    const fork = box.fork!;
    let forkAttempts = 0;
    box.fork = async (count, options) => {
      const result = await fork(count, options);
      forkAttempts += 1;
      if (forkAttempts === 1) throw new Error("response lost after commit");
      return result;
    };
    if (checkpoint.status !== "replayed" && checkpoint.status !== "created") {
      throw new Error("checkpoint recovery did not produce a reference");
    }
    const forkResult = await operations!.fork(forkRequest(checkpoint.checkpoint));
    expect(forkResult).toMatchObject({ status: "replayed" });
  });

  it("rehydrates a branch child when an acknowledgement omits createdAt", async () => {
    const { box, client } = createFakeSandbox();
    const operations = createTangleWorkspaceBranching({ box, client, provider });
    const checkpoint = await operations!.checkpoint(checkpointRequest());
    if (checkpoint.status !== "created") throw new Error("checkpoint setup failed");
    const fork = box.fork!;
    box.fork = async (count, options) => {
      const result = await fork(count, options);
      return {
        ...result,
        children: result.children.map((child) => {
          const { createdAt: _createdAt, ...withoutCreatedAt } = child;
          return withoutCreatedAt;
        }),
      };
    };
    const result = await operations!.fork(forkRequest(checkpoint.checkpoint));
    expect(result).toMatchObject({ status: "created" });
  });

  it("propagates cancellation without starting recovery traffic", async () => {
    const { box, client } = createFakeSandbox();
    const snapshot = box.snapshot!;
    let snapshotCalls = 0;
    let listCalls = 0;
    box.listSnapshots = async () => {
      listCalls += 1;
      return [];
    };
    box.snapshot = async (options) => {
      snapshotCalls += 1;
      await new Promise<void>(() => undefined);
      return snapshot(options);
    };
    const operations = createTangleWorkspaceBranching({ box, client, provider });
    const controller = new AbortController();
    const pending = operations!.checkpoint(checkpointRequest(), {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(snapshotCalls).toBe(1);
    expect(listCalls).toBe(1);
  });

  it("continues account inventory after a full Sandbox page", async () => {
    const { box, client } = createFakeSandbox();
    const operations = createTangleWorkspaceBranching({ box, client, provider });
    const checkpoint = await operations!.checkpoint(checkpointRequest());
    if (checkpoint.status !== "created") throw new Error("checkpoint setup failed");
    const forkInput = forkRequest(checkpoint.checkpoint);
    const fork = await operations!.fork(forkInput);
    if (fork.status !== "created") throw new Error("fork setup failed");

    const originalList = client.list!;
    const filler = Array.from({ length: 1_000 }, (_, index) => ({
      id: `inventory-filler-${index}`,
      async *streamPrompt() {},
    }));
    const calls: Array<{ limit?: number; offset?: number }> = [];
    client.list = async (options) => {
      calls.push({ limit: options?.limit, offset: options?.offset });
      const inventory = [...filler, ...(await originalList())];
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? inventory.length;
      return inventory.slice(offset, offset + limit);
    };

    const restarted = createTangleWorkspaceBranching({ box, client, provider });
    const result = await restarted!.lookupFork({
      idempotencyKey: forkInput.idempotencyKey,
      requestDigest: forkInput.requestDigest,
    });
    expect(result).toMatchObject({ status: "found", environment: fork.environment });
    expect(calls).toEqual([
      { limit: 1_000, offset: 0 },
      { limit: 1_000, offset: 1_000 },
    ]);
  });

  it("fails closed when a full page continuation is unavailable", async () => {
    const { box, client } = createFakeSandbox();
    const operations = createTangleWorkspaceBranching({ box, client, provider });
    const checkpoint = await operations!.checkpoint(checkpointRequest());
    if (checkpoint.status !== "created") throw new Error("checkpoint setup failed");
    const forkInput = forkRequest(checkpoint.checkpoint);
    const fork = await operations!.fork(forkInput);
    if (fork.status !== "created") throw new Error("fork setup failed");

    const originalList = client.list!;
    const filler = Array.from({ length: 1_000 }, (_, index) => ({
      id: `inventory-filler-${index}`,
      async *streamPrompt() {},
    }));
    const calls: Array<{ limit?: number; offset?: number }> = [];
    client.list = async (options) => {
      calls.push({ limit: options?.limit, offset: options?.offset });
      if ((options?.offset ?? 0) > 0) throw new Error("continuation unavailable");
      const inventory = [...filler, ...(await originalList())];
      return inventory.slice(0, options?.limit ?? inventory.length);
    };

    const restarted = createTangleWorkspaceBranching({ box, client, provider });
    await expect(
      restarted!.lookupFork({
        idempotencyKey: forkInput.idempotencyKey,
        requestDigest: forkInput.requestDigest,
      }),
    ).resolves.toMatchObject({ status: "unknown", retryable: true });
    expect(calls).toEqual([
      { limit: 1_000, offset: 0 },
      { limit: 1_000, offset: 1_000 },
    ]);
  });

  it("rejects an over-sized page instead of trusting a truncated response", async () => {
    const { box, client } = createFakeSandbox();
    const originalList = client.list!;
    const filler = Array.from({ length: 1_001 }, (_, index) => ({
      id: `inventory-filler-${index}`,
      async *streamPrompt() {},
    }));
    let observedLimit: number | undefined;
    client.list = async (options) => {
      observedLimit = options?.limit;
      const inventory = [...filler, ...(await originalList())];
      return inventory;
    };

    const operations = createTangleWorkspaceBranching({ box, client, provider });
    const result = await operations!.lookupFork({
      idempotencyKey: "missing-fork",
      requestDigest: workspaceForkRequestDigest({
        checkpoint: {
          checkpointId: "missing-checkpoint",
          provider,
          source,
          idempotencyKey: "missing-checkpoint-operation",
          requestDigest: workspaceCheckpointRequestDigest({ source }),
          createdAt: "2026-08-28T00:00:00.000Z",
        },
        name: "missing",
        placement: { kind: "sandbox", sandboxId: sourceEnvironmentId },
      }),
    });
    expect(result).toMatchObject({ status: "unknown", retryable: true });
    expect(observedLimit).toBe(1_000);
  });

  it("rejects a continuation that repeats an earlier page", async () => {
    const { box, client } = createFakeSandbox();
    const originalList = client.list!;
    const filler = Array.from({ length: 1_000 }, (_, index) => ({
      id: `inventory-filler-${index}`,
      async *streamPrompt() {},
    }));
    client.list = async (options) => {
      const inventory = [...filler, ...(await originalList())];
      return inventory.slice(0, options?.limit ?? inventory.length);
    };

    const operations = createTangleWorkspaceBranching({ box, client, provider });
    const result = await operations!.lookupFork({
      idempotencyKey: "missing-fork",
      requestDigest: workspaceForkRequestDigest({
        checkpoint: {
          checkpointId: "missing-checkpoint",
          provider,
          source,
          idempotencyKey: "missing-checkpoint-operation",
          requestDigest: workspaceCheckpointRequestDigest({ source }),
          createdAt: "2026-08-28T00:00:00.000Z",
        },
        name: "missing",
        placement: { kind: "sandbox", sandboxId: sourceEnvironmentId },
      }),
    });
    expect(result).toMatchObject({ status: "unknown", retryable: true });
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
    expect(forkedEnvironmentConfidentialityVerified(request, environment, () => false)).toBe(false);
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
            : options?.attestationNonce === "nonce-missing"
              ? {}
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

    const withoutVerifier = createTangleWorkspaceBranching({
      box: attestationBox,
      client,
      provider,
    });
    await expect(
      withoutVerifier!.fork(makeRequest("fork-without-verifier", "nonce-without-verifier")),
    ).resolves.toMatchObject({ status: "unknown", retryable: false });

    const acceptedRequest = makeRequest("fork-accepted", "nonce-accepted");
    const accepted = await operations!.fork(acceptedRequest);
    expect(accepted.status).toBe("created");
    if (accepted.status !== "created") throw new Error("accepted fork setup failed");
    expect(accepted.environment.confidentialAttestation).toBeDefined();
    expect(
      forkedEnvironmentConfidentialityVerified(
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

    const missingNonce = await operations!.fork(
      makeRequest("fork-rejected-missing-nonce", "nonce-missing"),
    );
    expect(missingNonce.status).toBe("created");
    if (missingNonce.status !== "created") throw new Error("missing nonce fork setup failed");
    expect(missingNonce.environment.confidentialAttestation).toBeUndefined();

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

import { describe, expect, it } from "vitest";
import { SandboxInstance } from "@tangle-network/sandbox";
import {
  canonicalCandidateDigest,
  confidentialExecutionRequestDigest,
  forkedEnvironmentConfidentialityVerified,
  sha256Bytes,
  workspaceCleanupRequestDigest,
  workspaceCheckpointRequestDigest,
  workspaceForkRequestDigest,
} from "@tangle-network/agent-interface";
import type {
  WorkspaceCheckpointRequest,
  WorkspaceCheckpointRef,
  WorkspaceCleanupRequest,
  WorkspaceForkRequest,
} from "@tangle-network/agent-interface";
import { runWorkspaceBranchingConformance } from "@tangle-network/agent-provider-testkit";
import {
  createTangleWorkspaceBranching,
  supportsWorkspaceBranching,
} from "./tangle-workspace-branching.js";
import { decodeTangleConfidentialAttestationQuote } from "./tangle-confidential-attestation.js";
import { createTangleProvider } from "./tangle-provider.js";
import type { SandboxClientLike, SandboxInstanceLike } from "./tangle-types.js";

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

function testAttestationNonce(label: string): string {
  return canonicalCandidateDigest({ nonce: label }).slice("sha256:".length);
}

async function seedLegacyFork(
  client: SandboxClientLike,
  request: WorkspaceForkRequest
): Promise<SandboxInstanceLike> {
  return client.create({
    fromSnapshot: request.checkpoint.checkpointId,
    fromSandboxId: request.checkpoint.source.environmentId,
    idempotencyKey: request.idempotencyKey,
    metadata: {
      __tangle_agent_workspace_v1: {
        version: 1,
        kind: "fork",
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
        request,
        materialization: "snapshot",
      },
    },
  });
}

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
            `server-${canonicalCandidateDigest(key).replace(":", "-")}`
          )
        );
        if (!snapshot) throw new Error("snapshot ledger lost its resource");
        return {
          snapshotId: snapshot.snapshotId,
          createdAt: snapshot.createdAt,
          tags: snapshot.tags,
          idempotency: {
            outcome:
              previousDigest === digest
                ? ("replayed" as const)
                : ("replayed" as const),
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
      const index = snapshots.findIndex(
        (item) => item.snapshotId === snapshotId
      );
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
          (item) => item.metadata?.serverForkKey === key
        );
        if (!child) throw new Error("fork ledger lost its child");
        return {
          children: [child],
          requestedCount: 1,
          materializedCount: 1,
          complete: true,
          idempotency: {
            outcome:
              previousDigest === digest
                ? ("replayed" as const)
                : ("replayed" as const),
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
        ? {
            outcome: "found" as const,
            kind: "fork" as const,
            state: "succeeded" as const,
          }
        : { outcome: "not_found" as const, kind: "fork" as const };
    },
  };

  const client: SandboxClientLike = {
    async create(options) {
      if (
        options?.fromSnapshot === undefined ||
        options.fromSandboxId !== sourceEnvironmentId
      ) {
        return box;
      }
      const key = options.idempotencyKey ?? "without-key";
      const digest = canonicalCandidateDigest(options);
      const previousDigest = forkKeys.get(key);
      if (previousDigest !== undefined) {
        const child = [...children.values()].find(
          (item) => item.metadata?.serverForkKey === key
        );
        if (!child) throw new Error("snapshot restore ledger lost its child");
        return {
          ...child,
          createReceipt: () => ({
            outcome: "idempotent_replay" as const,
            idempotencyKeyApplied: true,
          }),
        };
      }
      forkKeys.set(key, digest);
      const childId = `fork-${++childNumber}`;
      const child: SandboxInstanceLike = {
        id: childId,
        createdAt: new Date("2026-08-28T00:00:01.000Z"),
        metadata: {
          ...(options.metadata ?? {}),
          serverForkKey: key,
        },
        createReceipt: () => ({
          outcome: "created" as const,
          idempotencyKeyApplied: true,
        }),
        async *streamPrompt() {},
        async delete() {
          children.delete(childId);
          return { sandboxId: childId, outcome: "destroyed" as const };
        },
      };
      children.set(childId, child);
      return {
        ...child,
        createReceipt: () => ({
          outcome: "created" as const,
          idempotencyKeyApplied: true,
        }),
      };
    },
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
  const material = {
    source,
    name: "before-analysis",
    metadata: { suite: "provider" },
  };
  return {
    ...material,
    idempotencyKey: "checkpoint-operation",
    requestDigest: workspaceCheckpointRequestDigest(material),
  };
}

async function checkpointWithHiddenInventoryMarker() {
  const { box, client } = createFakeSandbox();
  const request = checkpointRequest();
  const first = createTangleWorkspaceBranching({ box, client, provider });
  const created = await first!.checkpoint(request);
  if (created.status !== "created") {
    throw new Error("checkpoint setup failed");
  }
  const snapshots = await box.listSnapshots?.();
  const snapshot = snapshots?.[0];
  if (!snapshot) throw new Error("snapshot setup failed");
  box.listSnapshots = async () => [
    { ...snapshot, tags: ["storage-inventory-retained"] },
  ];
  return { box, client, request, created, snapshot };
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
        client
      )
    ).toBe(false);
  });
  it("passes exact checkpoint, fork, recovery, conflict, and cleanup conformance", async () => {
    const { box, client } = createFakeSandbox();
    const operations = createTangleWorkspaceBranching({
      box,
      client,
      provider,
    });
    expect(operations).toBeDefined();
    const result = await runWorkspaceBranchingConformance({
      name: "fake Sandbox",
      operations: operations!,
      checkpointRequest: checkpointRequest(),
      forkRequest: (checkpoint) => forkRequest(checkpoint),
    });
    expect(result.checked).toContain("confirmed-cleanup");
  });

  it("restores each fork from its exact checkpoint snapshot", async () => {
    const { box, client } = createFakeSandbox();
    let observedCreate: Parameters<SandboxClientLike["create"]>[0];
    let forkCalls = 0;
    const originalFork = box.fork!;
    box.fork = async (count, options) => {
      forkCalls += 1;
      return originalFork(count, options);
    };
    const create = client.create;
    client.create = async (options, requestOptions) => {
      observedCreate = options;
      return create(options, requestOptions);
    };
    const operations = createTangleWorkspaceBranching({
      box,
      client,
      provider,
    });
    const checkpoint = await operations!.checkpoint(checkpointRequest());
    if (checkpoint.status !== "created")
      throw new Error("checkpoint setup failed");
    const request = forkRequest(checkpoint.checkpoint);
    await expect(operations!.fork(request)).resolves.toMatchObject({
      status: "created",
    });
    expect(observedCreate).toMatchObject({
      fromSnapshot: checkpoint.checkpoint.checkpointId,
      fromSandboxId: sourceEnvironmentId,
      idempotencyKey: request.idempotencyKey,
      name: request.name,
    });
    expect(observedCreate?.metadata).toMatchObject({ lane: "analysis" });
    expect(forkCalls).toBe(0);
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
    const operations = createTangleWorkspaceBranching({
      box,
      client,
      provider,
    });
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
    const operations = createTangleWorkspaceBranching({
      box,
      client,
      provider,
    });
    const result = await operations!.checkpoint(request);
    if (result.status !== "created") {
      throw new Error(`long-key checkpoint failed: ${JSON.stringify(result)}`);
    }
    expect(observedTags).toBeDefined();
    expect(
      observedTags!.every(
        (tag) =>
          Buffer.byteLength(tag, "utf8") <= 128 &&
          /^[A-Za-z0-9._-]+$/u.test(tag)
      )
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
    const encoded = Buffer.from(JSON.stringify(marker), "utf8").toString(
      "base64url"
    );
    const chunks: string[] = [];
    for (let index = 0; index < encoded.length; index += 240) {
      chunks.push(encoded.slice(index, index + 240));
    }
    const base = "tangle-agent-sdk:workspace:v1:checkpoint";
    const legacyTags = [
      `${base}:key:${Buffer.from(request.idempotencyKey, "utf8").toString(
        "base64url"
      )}`,
      `${base}:digest:${request.requestDigest}`,
      ...chunks.map(
        (chunk, index) => `${base}:material:${index}:${chunks.length}:${chunk}`
      ),
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
        ? {
            outcome: "found" as const,
            kind: "checkpoint" as const,
            state: "succeeded" as const,
          }
        : { outcome: "not_found" as const, kind: "checkpoint" as const };
    };

    const operations = createTangleWorkspaceBranching({
      box,
      client,
      provider,
    });
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
    const operations = createTangleWorkspaceBranching({
      box,
      client,
      provider,
    });
    const checkpoint = await operations!.checkpoint(checkpointRequest());
    if (checkpoint.status !== "created")
      throw new Error("checkpoint setup failed");
    box.listSnapshots = async () => [];
    await expect(
      operations!.fork(forkRequest(checkpoint.checkpoint))
    ).resolves.toMatchObject({
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
    const operations = createTangleWorkspaceBranching({
      box,
      client,
      provider,
    });
    const checkpoint = await operations!.checkpoint(checkpointRequest());
    expect(checkpoint).toMatchObject({ status: "replayed" });

    const create = client.create;
    let forkAttempts = 0;
    client.create = async (options, requestOptions) => {
      const result = await create(options, requestOptions);
      forkAttempts += 1;
      if (forkAttempts === 1) throw new Error("response lost after commit");
      return result;
    };
    if (checkpoint.status !== "replayed" && checkpoint.status !== "created") {
      throw new Error("checkpoint recovery did not produce a reference");
    }
    const forkResult = await operations!.fork(
      forkRequest(checkpoint.checkpoint)
    );
    expect(forkResult).toMatchObject({ status: "replayed" });
  });

  it("rehydrates a branch child when an acknowledgement omits createdAt", async () => {
    const { box, client } = createFakeSandbox();
    const operations = createTangleWorkspaceBranching({
      box,
      client,
      provider,
    });
    const checkpoint = await operations!.checkpoint(checkpointRequest());
    if (checkpoint.status !== "created")
      throw new Error("checkpoint setup failed");
    const create = client.create;
    client.create = async (options, requestOptions) => {
      const child = await create(options, requestOptions);
      const { createdAt: _createdAt, ...withoutCreatedAt } = child;
      return withoutCreatedAt;
    };
    const result = await operations!.fork(forkRequest(checkpoint.checkpoint));
    expect(result).toMatchObject({ status: "created" });
  });

  it("rehydrates a branch child when an acknowledgement omits recovery metadata", async () => {
    const { box, client } = createFakeSandbox();
    const operations = createTangleWorkspaceBranching({
      box,
      client,
      provider,
    });
    const checkpoint = await operations!.checkpoint(checkpointRequest());
    if (checkpoint.status !== "created")
      throw new Error("checkpoint setup failed");
    const create = client.create;
    client.create = async (options, requestOptions) => {
      const child = await create(options, requestOptions);
      const { metadata: _metadata, ...withoutMetadata } = child;
      return withoutMetadata;
    };
    const result = await operations!.fork(forkRequest(checkpoint.checkpoint));
    expect(result).toMatchObject({ status: "created" });
  });

  it("removes a newly created child when no durable recovery marker exists", async () => {
    const { box, client } = createFakeSandbox();
    const operations = createTangleWorkspaceBranching({
      box,
      client,
      provider,
    });
    const checkpoint = await operations!.checkpoint(checkpointRequest());
    if (checkpoint.status !== "created")
      throw new Error("checkpoint setup failed");
    const create = client.create;
    let childId: string | undefined;
    client.create = async (options, requestOptions) => {
      const child = await create(options, requestOptions);
      childId = child.id;
      child.metadata = { serverForkKey: options?.idempotencyKey };
      const stored = await client.get!(child.id);
      if (stored) stored.metadata = child.metadata;
      return child;
    };

    const result = await operations!.fork(forkRequest(checkpoint.checkpoint));
    expect(result).toMatchObject({
      status: "unknown",
      retryable: false,
      message: expect.stringContaining("newly created child was removed"),
    });
    expect(childId).toBeDefined();
    expect(await client.get!(childId!)).toBeNull();
  });

  it("does not remove a child marked for another fork operation", async () => {
    const { box, client } = createFakeSandbox();
    const operations = createTangleWorkspaceBranching({
      box,
      client,
      provider,
    });
    const checkpoint = await operations!.checkpoint(checkpointRequest());
    if (checkpoint.status !== "created")
      throw new Error("checkpoint setup failed");
    const request = forkRequest(checkpoint.checkpoint);
    const create = client.create;
    let childId: string | undefined;
    const otherMaterial = {
      checkpoint: request.checkpoint,
      name: "other-worker",
      metadata: { lane: "other" },
      placement: { kind: "sandbox", sandboxId: "fork-placement" } as const,
    };
    const otherRequest: WorkspaceForkRequest = {
      ...otherMaterial,
      idempotencyKey: "other-fork-operation",
      requestDigest: workspaceForkRequestDigest(otherMaterial),
    };
    client.create = async (options, requestOptions) => {
      const child = await create(options, requestOptions);
      childId = child.id;
      child.metadata = {
        __tangle_agent_workspace_v1: {
          version: 1,
          kind: "fork",
          idempotencyKey: otherRequest.idempotencyKey,
          requestDigest: otherRequest.requestDigest,
          request: otherRequest,
        },
      };
      const stored = await client.get!(child.id);
      if (stored) stored.metadata = child.metadata;
      return child;
    };

    await expect(operations!.fork(request)).resolves.toMatchObject({
      status: "conflict",
      existingRequestDigest: otherRequest.requestDigest,
    });
    expect(childId).toBeDefined();
    expect(await client.get!(childId!)).not.toBeNull();
  });

  it("removes a newly created child when identity recovery is unavailable", async () => {
    const { box, client } = createFakeSandbox();
    const operations = createTangleWorkspaceBranching({
      box,
      client,
      provider,
    });
    const checkpoint = await operations!.checkpoint(checkpointRequest());
    if (checkpoint.status !== "created")
      throw new Error("checkpoint setup failed");
    const create = client.create;
    let childId: string | undefined;
    client.create = async (options, requestOptions) => {
      const child = await create(options, requestOptions);
      childId = child.id;
      const {
        createdAt: _createdAt,
        metadata: _metadata,
        ...withoutIdentity
      } = child;
      return withoutIdentity;
    };
    client.get = async (id) => (id === sourceEnvironmentId ? box : null);

    await expect(
      operations!.fork(forkRequest(checkpoint.checkpoint))
    ).resolves.toMatchObject({
      status: "unknown",
      retryable: false,
      message: expect.stringContaining("newly created child was removed"),
    });
    expect(childId).toBeDefined();
    expect(await client.get!(childId!)).toBeNull();
  });

  it("never removes a replayed child whose durable recovery marker is unavailable", async () => {
    const { box, client } = createFakeSandbox();
    const first = createTangleWorkspaceBranching({ box, client, provider });
    const checkpoint = await first!.checkpoint(checkpointRequest());
    if (checkpoint.status !== "created")
      throw new Error("checkpoint setup failed");
    const request = forkRequest(checkpoint.checkpoint);
    const created = await first!.fork(request);
    if (created.status !== "created") throw new Error("fork setup failed");
    const child = await client.get!(created.environment.environmentId);
    if (!child) throw new Error("fork child setup failed");
    let deleteCalls = 0;
    const remove = child.delete!;
    child.delete = async () => {
      deleteCalls += 1;
      return remove();
    };
    child.metadata = { serverForkKey: request.idempotencyKey };

    const restarted = createTangleWorkspaceBranching({ box, client, provider });
    const replay = await restarted!.fork(request);
    expect(replay).toMatchObject({ status: "unknown", retryable: true });
    expect(deleteCalls).toBe(0);
    expect(await client.get!(child.id)).not.toBeNull();
  });

  it("uses the reconstructed fork child for replay cleanup", async () => {
    const { box, client } = createFakeSandbox();
    const first = createTangleWorkspaceBranching({ box, client, provider });
    const checkpoint = await first!.checkpoint(checkpointRequest());
    if (checkpoint.status !== "created")
      throw new Error("checkpoint setup failed");
    const request = forkRequest(checkpoint.checkpoint);
    const created = await first!.fork(request);
    if (created.status !== "created") throw new Error("fork setup failed");
    const child = await client.get!(created.environment.environmentId);
    if (!child) throw new Error("fork child setup failed");

    const list = client.list!;
    client.list = async (options) => {
      const children = await list(options);
      return children.map((candidate) => {
        if (candidate.id !== child.id) return candidate;
        const { createdAt: _createdAt, delete: _delete, ...incomplete } =
          candidate;
        return incomplete;
      });
    };

    const restarted = createTangleWorkspaceBranching({ box, client, provider });
    const replay = await restarted!.fork(request);
    expect(replay).toMatchObject({ status: "replayed" });

    const material = {
      kind: "fork" as const,
      targetId: child.id,
      provider,
    };
    const cleanup: WorkspaceCleanupRequest & { kind: "fork" } = {
      ...material,
      operationId: "cleanup-reconstructed-fork",
      requestDigest: workspaceCleanupRequestDigest(material),
    };
    await expect(restarted!.destroyFork(cleanup)).resolves.toMatchObject({
      status: "deleted",
    });
    expect(await client.get!(child.id)).toBeNull();
  });

  it("reports uncertain cleanup when a newly created unmarked child cannot be removed", async () => {
    const { box, client } = createFakeSandbox();
    const operations = createTangleWorkspaceBranching({
      box,
      client,
      provider,
    });
    const checkpoint = await operations!.checkpoint(checkpointRequest());
    if (checkpoint.status !== "created")
      throw new Error("checkpoint setup failed");
    const create = client.create;
    let childId: string | undefined;
    client.create = async (options, requestOptions) => {
      const child = await create(options, requestOptions);
      childId = child.id;
      child.metadata = { serverForkKey: options?.idempotencyKey };
      const stored = await client.get!(child.id);
      if (stored) stored.metadata = child.metadata;
      child.delete = async () => ({
        sandboxId: child.id,
        outcome: "unknown" as const,
      });
      return child;
    };

    const result = await operations!.fork(forkRequest(checkpoint.checkpoint));
    expect(result).toMatchObject({
      status: "unknown",
      retryable: true,
      message: expect.stringContaining("cleanup was not confirmed"),
    });
    expect(childId).toBeDefined();
    expect(await client.get!(childId!)).not.toBeNull();
  });

  it("stops before checkpoint creation when key recovery is cancelled", async () => {
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
    const operations = createTangleWorkspaceBranching({
      box,
      client,
      provider,
    });
    const controller = new AbortController();
    const pending = operations!.checkpoint(checkpointRequest(), {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(snapshotCalls).toBe(0);
    expect(listCalls).toBe(1);
  });

  it("does not invoke checkpoint recovery after cancellation", async () => {
    const { box, client } = createFakeSandbox();
    let listCalls = 0;
    let lookupCalls = 0;
    let snapshotCalls = 0;
    box.listSnapshots = async () => {
      listCalls += 1;
      return [];
    };
    box.getSnapshotOperation = async () => {
      lookupCalls += 1;
      return { outcome: "not_found", kind: "checkpoint" };
    };
    box.snapshot = async () => {
      snapshotCalls += 1;
      throw new Error("checkpoint creation must not run");
    };
    const operations = createTangleWorkspaceBranching({
      box,
      client,
      provider,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      operations!.checkpoint(checkpointRequest(), {
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(listCalls).toBe(0);
    expect(lookupCalls).toBe(0);
    expect(snapshotCalls).toBe(0);
  });

  it("continues account inventory after a full Sandbox page", async () => {
    const { box, client } = createFakeSandbox();
    const operations = createTangleWorkspaceBranching({
      box,
      client,
      provider,
    });
    const checkpoint = await operations!.checkpoint(checkpointRequest());
    if (checkpoint.status !== "created")
      throw new Error("checkpoint setup failed");
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
    expect(result).toMatchObject({
      status: "found",
      environment: fork.environment,
    });
    expect(calls).toEqual([
      { limit: 1_000, offset: 0 },
      { limit: 1_000, offset: 1_000 },
    ]);
  });

  it("fails closed when a full page continuation is unavailable", async () => {
    const { box, client } = createFakeSandbox();
    const operations = createTangleWorkspaceBranching({
      box,
      client,
      provider,
    });
    const checkpoint = await operations!.checkpoint(checkpointRequest());
    if (checkpoint.status !== "created")
      throw new Error("checkpoint setup failed");
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
      if ((options?.offset ?? 0) > 0)
        throw new Error("continuation unavailable");
      const inventory = [...filler, ...(await originalList())];
      return inventory.slice(0, options?.limit ?? inventory.length);
    };

    const restarted = createTangleWorkspaceBranching({ box, client, provider });
    await expect(
      restarted!.lookupFork({
        idempotencyKey: forkInput.idempotencyKey,
        requestDigest: forkInput.requestDigest,
      })
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

    const operations = createTangleWorkspaceBranching({
      box,
      client,
      provider,
    });
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

    const operations = createTangleWorkspaceBranching({
      box,
      client,
      provider,
    });
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
    const operations = createTangleWorkspaceBranching({
      box,
      client,
      provider,
    });
    const request = checkpointRequest();
    const [first, second] = await Promise.all([
      operations!.checkpoint(request),
      operations!.checkpoint(request),
    ]);
    expect([first.status, second.status].sort()).toEqual([
      "created",
      "replayed",
    ]);
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
    if (checkpoint.status !== "created")
      throw new Error("checkpoint setup failed");
    const fork = await first!.fork(forkRequest(checkpoint.checkpoint));
    expect(fork.status).toBe("created");
    if (fork.status !== "created") throw new Error("fork setup failed");

    const restarted = createTangleWorkspaceBranching({ box, client, provider });
    const checkpointLookup = await restarted!.lookupCheckpoint({
      idempotencyKey: checkpointRequest().idempotencyKey,
      requestDigest: checkpointRequest().requestDigest,
    });
    expect(checkpointLookup).toMatchObject({
      status: "found",
      checkpoint: checkpoint.checkpoint,
    });
    const forkLookup = await restarted!.lookupFork({
      idempotencyKey: forkRequest(checkpoint.checkpoint).idempotencyKey,
      requestDigest: forkRequest(checkpoint.checkpoint).requestDigest,
    });
    expect(forkLookup).toMatchObject({
      status: "found",
      environment: fork.environment,
    });
  });

  it("recovers a live checkpoint when inventory omits its marker tags", async () => {
    const { box, client, request, created, snapshot } =
      await checkpointWithHiddenInventoryMarker();
    const lookupOptions: Array<{ tags?: string[] } | undefined> = [];
    box.getSnapshotOperation = async (_id, options) => {
      lookupOptions.push(options);
      return {
        outcome: "found",
        kind: "checkpoint",
        state: "succeeded",
        result: {
          snapshotId: snapshot.snapshotId,
          createdAt: snapshot.createdAt,
          tags: snapshot.tags,
        },
      };
    };

    const restarted = createTangleWorkspaceBranching({ box, client, provider });
    await expect(
      restarted!.lookupCheckpoint({
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
      })
    ).resolves.toMatchObject({
      status: "found",
      checkpoint: created.checkpoint,
    });
    expect(lookupOptions).toEqual([undefined]);
  });

  it("fails closed on duplicate snapshot identities during recovery", async () => {
    const { box, client, request, snapshot } =
      await checkpointWithHiddenInventoryMarker();
    box.listSnapshots = async () => [snapshot, { ...snapshot }];
    box.getSnapshotOperation = async () => ({
      outcome: "found",
      kind: "checkpoint",
      state: "succeeded",
    });

    const restarted = createTangleWorkspaceBranching({ box, client, provider });
    await expect(
      restarted!.lookupCheckpoint({
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
      })
    ).resolves.toMatchObject({ status: "unknown", retryable: true });
  });

  it("returns not_found when only the operation record retains a checkpoint", async () => {
    const { box, client, request, snapshot } =
      await checkpointWithHiddenInventoryMarker();
    box.listSnapshots = async () => [];
    box.getSnapshotOperation = async () => ({
      outcome: "found",
      kind: "checkpoint",
      state: "succeeded",
      result: {
        snapshotId: snapshot.snapshotId,
        createdAt: snapshot.createdAt,
        tags: snapshot.tags,
      },
    });

    const restarted = createTangleWorkspaceBranching({ box, client, provider });
    await expect(
      restarted!.lookupCheckpoint({
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
      })
    ).resolves.toMatchObject({ status: "not_found" });
  });

  it("does not create from a settled operation whose snapshot was deleted", async () => {
    const { box, client, request, snapshot } =
      await checkpointWithHiddenInventoryMarker();
    let snapshotCalls = 0;
    box.listSnapshots = async () => [];
    box.getSnapshotOperation = async () => ({
      outcome: "found",
      kind: "checkpoint",
      state: "succeeded",
      result: {
        snapshotId: snapshot.snapshotId,
        createdAt: snapshot.createdAt,
        tags: snapshot.tags,
      },
    });
    box.snapshot = async () => {
      snapshotCalls += 1;
      throw new Error("checkpoint creation must not run");
    };

    const restarted = createTangleWorkspaceBranching({ box, client, provider });
    await expect(restarted!.checkpoint(request)).resolves.toMatchObject({
      status: "unknown",
      retryable: false,
    });
    expect(snapshotCalls).toBe(0);
  });

  it("rejects a replay acknowledgement after the live snapshot disappears", async () => {
    const { box, client, request, snapshot } =
      await checkpointWithHiddenInventoryMarker();
    let lookupCalls = 0;
    let snapshotCalls = 0;
    box.listSnapshots = async () => [];
    box.getSnapshotOperation = async () => {
      lookupCalls += 1;
      if (lookupCalls === 1) {
        return { outcome: "not_found", kind: "checkpoint" };
      }
      return {
        outcome: "found",
        kind: "checkpoint",
        state: "succeeded",
        result: {
          snapshotId: snapshot.snapshotId,
          createdAt: snapshot.createdAt,
          tags: snapshot.tags,
        },
      };
    };
    box.snapshot = async () => {
      snapshotCalls += 1;
      return {
        snapshotId: snapshot.snapshotId,
        sandboxId: sourceEnvironmentId,
        createdAt: snapshot.createdAt,
        tags: snapshot.tags,
        idempotency: {
          outcome: "replayed",
          requestDigest: request.requestDigest,
        },
      };
    };

    const restarted = createTangleWorkspaceBranching({ box, client, provider });
    await expect(restarted!.checkpoint(request)).resolves.toMatchObject({
      status: "unknown",
      retryable: false,
    });
    expect(snapshotCalls).toBe(1);
    expect(lookupCalls).toBe(2);
  });

  it("reconciles a replay acknowledgement when its tags are omitted", async () => {
    const { box, client, request, created, snapshot } =
      await checkpointWithHiddenInventoryMarker();
    box.snapshot = async () => ({
      snapshotId: snapshot.snapshotId,
      sandboxId: sourceEnvironmentId,
      createdAt: snapshot.createdAt,
      tags: [],
      idempotency: {
        outcome: "replayed",
        requestDigest: request.requestDigest,
      },
    });
    box.getSnapshotOperation = async () => ({
      outcome: "found",
      kind: "checkpoint",
      state: "succeeded",
      result: {
        snapshotId: snapshot.snapshotId,
        createdAt: snapshot.createdAt,
        tags: snapshot.tags,
      },
    });

    const restarted = createTangleWorkspaceBranching({ box, client, provider });
    await expect(restarted!.checkpoint(request)).resolves.toMatchObject({
      status: "replayed",
      checkpoint: created.checkpoint,
    });
  });

  it("reports the interface conflict carried by operation-result tags", async () => {
    const { box, client, request, snapshot } =
      await checkpointWithHiddenInventoryMarker();
    box.getSnapshotOperation = async () => ({
      outcome: "found",
      kind: "checkpoint",
      state: "succeeded",
      result: {
        snapshotId: snapshot.snapshotId,
        createdAt: snapshot.createdAt,
        tags: snapshot.tags,
      },
    });

    const restarted = createTangleWorkspaceBranching({ box, client, provider });
    await expect(
      restarted!.lookupCheckpoint({
        idempotencyKey: request.idempotencyKey,
        requestDigest: canonicalCandidateDigest({ request: "different" }),
      })
    ).resolves.toMatchObject({
      status: "conflict",
      existingRequestDigest: request.requestDigest,
    });
  });

  it("fails closed when an operation result has no provider marker", async () => {
    const { box, client, request, snapshot } =
      await checkpointWithHiddenInventoryMarker();
    box.getSnapshotOperation = async () => ({
      outcome: "found",
      kind: "checkpoint",
      state: "succeeded",
      result: {
        snapshotId: snapshot.snapshotId,
        createdAt: snapshot.createdAt,
        tags: ["not-a-provider-marker"],
      },
    });

    const restarted = createTangleWorkspaceBranching({ box, client, provider });
    await expect(
      restarted!.lookupCheckpoint({
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
      })
    ).resolves.toMatchObject({ status: "unknown", retryable: true });
  });

  it("recovers exact refs from operation results when inventory timestamps drift", async () => {
    const { box, client } = createFakeSandbox();
    const first = createTangleWorkspaceBranching({ box, client, provider });
    const checkpointInput = checkpointRequest();
    const checkpoint = await first!.checkpoint(checkpointInput);
    if (checkpoint.status !== "created")
      throw new Error("checkpoint setup failed");
    const forkInput = forkRequest(checkpoint.checkpoint);
    const fork = await first!.fork(forkInput);
    if (fork.status !== "created") throw new Error("fork setup failed");
    const forkChild = await client.get!(fork.environment.environmentId);
    if (!forkChild) throw new Error("fork child setup failed");
    const forkMarker = forkChild.metadata?.__tangle_agent_workspace_v1;
    if (!forkMarker || typeof forkMarker !== "object")
      throw new Error("fork marker setup failed");
    const {
      materialization: _materialization,
      ...legacyForkMarker
    } = forkMarker as Record<string, unknown>;
    forkChild.metadata = {
      ...forkChild.metadata,
      __tangle_agent_workspace_v1: legacyForkMarker,
    };

    const listSnapshots = box.listSnapshots!;
    box.listSnapshots = async () =>
      (await listSnapshots()).map((snapshot) => ({
        ...snapshot,
        createdAt: new Date("2026-08-29T00:00:00.000Z"),
      }));
    const listEnvironments = client.list!;
    client.list = async (options) =>
      (await listEnvironments(options)).map((environment) => ({
        ...environment,
        createdAt: new Date("2026-08-29T00:00:01.000Z"),
      }));
    box.getSnapshotOperation = async () => ({
      outcome: "found",
      kind: "checkpoint",
      state: "succeeded",
      result: {
        snapshotId: checkpoint.checkpoint.checkpointId,
        createdAt: checkpoint.checkpoint.createdAt,
      },
    });
    box.getForkOperation = async () => ({
      outcome: "found",
      kind: "fork",
      state: "succeeded",
      result: {
        children: [
          {
            sandboxId: fork.environment.environmentId,
            createdAt: fork.environment.createdAt,
          },
        ],
      },
    });

    const restarted = createTangleWorkspaceBranching({ box, client, provider });
    const checkpointLookup = await restarted!.lookupCheckpoint({
      idempotencyKey: checkpointInput.idempotencyKey,
      requestDigest: checkpointInput.requestDigest,
    });
    expect(checkpointLookup.status).toBe("found");
    if (checkpointLookup.status !== "found")
      throw new Error("checkpoint lookup did not recover a ref");
    expect(checkpointLookup.checkpoint).toEqual(checkpoint.checkpoint);

    const forkLookup = await restarted!.lookupFork({
      idempotencyKey: forkInput.idempotencyKey,
      requestDigest: forkInput.requestDigest,
    });
    expect(forkLookup.status).toBe("found");
    if (forkLookup.status !== "found")
      throw new Error("fork lookup did not recover a ref");
    expect(forkLookup.environment).toEqual(fork.environment);
  });

  it("recovers fork children when operation results omit creation timestamps", async () => {
    const { box, client } = createFakeSandbox();
    const first = createTangleWorkspaceBranching({ box, client, provider });
    const checkpoint = await first!.checkpoint(checkpointRequest());
    if (checkpoint.status !== "created")
      throw new Error("checkpoint setup failed");
    const request = forkRequest(checkpoint.checkpoint);
    const fork = await first!.fork(request);
    if (fork.status !== "created") throw new Error("fork setup failed");

    box.getForkOperation = async () => ({
      outcome: "found",
      kind: "fork",
      state: "succeeded",
      result: {
        children: [{ sandboxId: fork.environment.environmentId }],
      },
    });

    const restarted = createTangleWorkspaceBranching({ box, client, provider });
    const lookup = await restarted!.lookupFork({
      idempotencyKey: request.idempotencyKey,
      requestDigest: request.requestDigest,
    });
    expect(lookup.status).toBe("found");
    if (lookup.status !== "found")
      throw new Error("fork lookup did not recover an omitted timestamp");
    expect(lookup.environment).toEqual(fork.environment);
  });

  it("preserves SDK child instances when operation results supply timestamps", async () => {
    const { box, client } = createFakeSandbox();
    const first = createTangleWorkspaceBranching({ box, client, provider });
    const checkpoint = await first!.checkpoint(checkpointRequest());
    if (checkpoint.status !== "created")
      throw new Error("checkpoint setup failed");
    const request = forkRequest(checkpoint.checkpoint);
    const marker = {
      version: 1 as const,
      kind: "fork" as const,
      idempotencyKey: request.idempotencyKey,
      requestDigest: request.requestDigest,
      request,
    };
    const child = new SandboxInstance({} as never, {
      id: "sdk-fork-child",
      status: "running",
      createdAt: new Date("2026-08-28T00:00:01.000Z"),
      metadata: { __tangle_agent_workspace_v1: marker },
    });
    const authoritativeCreatedAt = new Date("2026-08-28T00:00:02.000Z");
    client.list = async () => [child as unknown as SandboxInstanceLike];
    box.getForkOperation = async () => ({
      outcome: "found",
      kind: "fork",
      state: "succeeded",
      result: {
        children: [
          { sandboxId: child.id, createdAt: authoritativeCreatedAt },
        ],
      },
    });

    const restarted = createTangleWorkspaceBranching({ box, client, provider });
    const lookup = await restarted!.lookupFork({
      idempotencyKey: request.idempotencyKey,
      requestDigest: request.requestDigest,
    });
    expect(lookup.status).toBe("found");
    if (lookup.status !== "found")
      throw new Error("fork lookup did not recover an SDK child");
    expect(lookup.environment).toMatchObject({
      environmentId: child.id,
      createdAt: authoritativeCreatedAt.toISOString(),
    });
  });

  it("fails closed when operation results are invalid or name different resources", async () => {
    const { box, client } = createFakeSandbox();
    const first = createTangleWorkspaceBranching({ box, client, provider });
    const checkpointInput = checkpointRequest();
    const checkpoint = await first!.checkpoint(checkpointInput);
    if (checkpoint.status !== "created")
      throw new Error("checkpoint setup failed");
    const forkInput = forkRequest(checkpoint.checkpoint);
    const fork = await first!.fork(forkInput);
    if (fork.status !== "created") throw new Error("fork setup failed");
    const forkChild = await client.get!(fork.environment.environmentId);
    if (!forkChild) throw new Error("fork child setup failed");
    const forkMarker = forkChild.metadata?.__tangle_agent_workspace_v1;
    if (!forkMarker || typeof forkMarker !== "object")
      throw new Error("fork marker setup failed");
    const {
      materialization: _materialization,
      ...legacyForkMarker
    } = forkMarker as Record<string, unknown>;
    forkChild.metadata = {
      ...forkChild.metadata,
      __tangle_agent_workspace_v1: legacyForkMarker,
    };

    box.getSnapshotOperation = async () => ({
      outcome: "found",
      kind: "checkpoint",
      state: "succeeded",
      result: {
        snapshotId: "different-checkpoint",
        createdAt: checkpoint.checkpoint.createdAt,
      },
    });
    box.getForkOperation = async () => ({
      outcome: "found",
      kind: "fork",
      state: "succeeded",
      result: {
        children: [
          {
            sandboxId: "different-fork",
            createdAt: fork.environment.createdAt,
          },
        ],
      },
    });

    const restarted = createTangleWorkspaceBranching({ box, client, provider });
    await expect(
      restarted!.lookupCheckpoint({
        idempotencyKey: checkpointInput.idempotencyKey,
        requestDigest: checkpointInput.requestDigest,
      })
    ).resolves.toMatchObject({ status: "unknown", retryable: true });
    await expect(
      restarted!.lookupFork({
        idempotencyKey: forkInput.idempotencyKey,
        requestDigest: forkInput.requestDigest,
      })
    ).resolves.toMatchObject({ status: "unknown", retryable: true });

    box.getSnapshotOperation = async () => ({
      outcome: "found" as const,
      kind: "checkpoint" as const,
      state: "succeeded" as const,
      result: {
        snapshotId: checkpoint.checkpoint.checkpointId,
        createdAt: null,
      },
    });
    box.getForkOperation = async () => ({
      outcome: "found" as const,
      kind: "fork" as const,
      state: "succeeded" as const,
      result: {
        children: [
          {
            sandboxId: fork.environment.environmentId,
            createdAt: null,
          },
        ],
      },
    });

    await expect(
      restarted!.lookupCheckpoint({
        idempotencyKey: checkpointInput.idempotencyKey,
        requestDigest: checkpointInput.requestDigest,
      })
    ).resolves.toMatchObject({ status: "unknown", retryable: true });
    await expect(
      restarted!.lookupFork({
        idempotencyKey: forkInput.idempotencyKey,
        requestDigest: forkInput.requestDigest,
      })
    ).resolves.toMatchObject({
      status: "found",
      environment: {
        environmentId: fork.environment.environmentId,
        createdAt: fork.environment.createdAt,
      },
    });

    const listChildren = client.list;
    if (listChildren === undefined) throw new Error("the fake client has no list method");
    const listedChildren = await listChildren();
    client.list = async () =>
      listedChildren.map((child) => ({
        ...child,
        createdAt: undefined,
      }));

    const noTimestampRestarted = createTangleWorkspaceBranching({
      box,
      client,
      provider,
    });
    await expect(
      noTimestampRestarted!.lookupFork({
        idempotencyKey: forkInput.idempotencyKey,
        requestDigest: forkInput.requestDigest,
      })
    ).resolves.toMatchObject({ status: "unknown", retryable: true });
  });

  it("reconstructs the source-scoped handle from the provider after restart", async () => {
    const { box, client } = createFakeSandbox();
    const firstProvider = createTangleProvider({ client, name: provider });
    const first = await firstProvider.workspaceBranching?.forEnvironment(
      sourceEnvironmentId
    );
    expect(first).toBeDefined();
    const checkpoint = await first!.checkpoint(checkpointRequest());
    expect(checkpoint.status).toBe("created");

    const restartedProvider = createTangleProvider({ client, name: provider });
    const restarted =
      await restartedProvider.workspaceBranching?.forEnvironment(
        sourceEnvironmentId
      );
    expect(restarted).toBeDefined();
    expect(
      await restarted!.lookupCheckpoint({
        idempotencyKey: checkpointRequest().idempotencyKey,
        requestDigest: checkpointRequest().requestDigest,
      })
    ).toMatchObject({ status: "found" });
    expect(
      await restartedProvider.workspaceBranching?.forEnvironment("missing")
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
          attestationNonce:
            options?.attestationNonce === "wrong"
              ? "other"
              : options?.attestationNonce,
          attestation: {
            tee_type: "tdx",
            evidence: [1, 2, 3],
            measurement: [4, 5, 6],
            timestamp: 1_756_368_000,
          },
        };
      },
    };
    const verifier = async ({
      attestation,
    }: {
      attestation: { measurement: `sha256:${string}` };
    }) => ({
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
    expect(
      forkedEnvironmentConfidentialityVerified(
        request,
        environment,
        () => false
      )
    ).toBe(false);
    expect(confidentialExecutionRequestDigest(request.confidential!)).toMatch(
      /^sha256:/
    );
  });

  it("refuses confidential forks before create when the wire cannot preserve the request", async () => {
    const { box, client } = createFakeSandbox();
    const checkpointOperations = createTangleWorkspaceBranching({
      box,
      client,
      provider,
    });
    const checkpoint = await checkpointOperations!.checkpoint(
      checkpointRequest()
    );
    if (checkpoint.status !== "created")
      throw new Error("checkpoint setup failed");

    const attestationBox: SandboxInstanceLike = {
      ...box,
      async getTeeAttestation() {
        throw new Error("the parent must not be attested");
      },
    };
    let createCalls = 0;
    client.create = async () => {
      createCalls += 1;
      throw new Error("create must not run");
    };
    const operations = createTangleWorkspaceBranching({
      box: attestationBox,
      client,
      provider,
      confidentialAttestationVerifier: async () => ({
        providerKeyId: "provider-key",
        providerSignature: "provider-signature",
      }),
    });
    const requestFor = (
      idempotencyKey: string,
      confidential: NonNullable<WorkspaceForkRequest["confidential"]>
    ): WorkspaceForkRequest => {
      const material = {
        checkpoint: checkpoint.checkpoint,
        placement: { kind: "sandbox", sandboxId: sourceEnvironmentId } as const,
        confidential,
      };
      return {
        ...material,
        idempotencyKey,
        requestDigest: workspaceForkRequestDigest(material),
      };
    };
    const validNonce = testAttestationNonce("valid");
    await expect(
      operations!.fork(
        requestFor("fork-invalid-nonce", {
          requested: true,
          tee: "nitro",
          nonce: "not-hex",
          policy: "policy-nitro",
          profileDigest: canonicalCandidateDigest({ profile: "worker" }),
        })
      )
    ).resolves.toMatchObject({
      status: "unknown",
      retryable: false,
      message: expect.stringMatching(/hexadecimal/),
    });
    await expect(
      operations!.fork(
        requestFor("fork-sealed", {
          requested: true,
          tee: "nitro",
          sealed: true,
          nonce: validNonce,
          policy: "policy-nitro",
          profileDigest: canonicalCandidateDigest({ profile: "worker" }),
        })
      )
    ).resolves.toMatchObject({
      status: "unknown",
      retryable: false,
      message: expect.stringMatching(/sealed/),
    });
    await expect(
      operations!.fork(
        requestFor("fork-snapshot", {
          requested: true,
          tee: "nitro",
          nonce: validNonce,
          policy: "policy-nitro",
          profileDigest: canonicalCandidateDigest({ profile: "worker" }),
        })
      )
    ).resolves.toMatchObject({
      status: "unknown",
      retryable: false,
      message: expect.stringMatching(/snapshot restore/),
    });
    expect(createCalls).toBe(0);
  });

  it("returns a confidential claim only after the external verifier accepts the raw quote", async () => {
    const { box, client } = createFakeSandbox();
    const checkpointOperations = createTangleWorkspaceBranching({
      box,
      client,
      provider,
    });
    const checkpoint = await checkpointOperations!.checkpoint(
      checkpointRequest()
    );
    if (checkpoint.status !== "created")
      throw new Error("checkpoint setup failed");

    const attestationBox: SandboxInstanceLike = {
      ...box,
      async getTeeAttestation() {
        throw new Error("the parent must not be attested");
      },
    };
    const originalCreate = client.create;
    const nonceMismatch = testAttestationNonce("mismatch");
    const nonceMissing = testAttestationNonce("missing");
    const nonceMeasurement = testAttestationNonce("measurement");
    client.create = async (options, requestOptions) => {
      const child = await originalCreate(options, requestOptions);
      const getTeeAttestation = async (attestationOptions?: {
        attestationNonce?: string;
      }) => ({
        sandbox_id: child.id,
        ...(attestationOptions?.attestationNonce === nonceMismatch
          ? { attestationNonce: "different-nonce" }
          : attestationOptions?.attestationNonce === nonceMissing
          ? {}
          : attestationOptions?.attestationNonce === undefined
          ? {}
          : { attestationNonce: attestationOptions.attestationNonce }),
        attestation: {
          tee_type: "tdx",
          evidence: [1, 2, 3],
          measurement: [4, 5, 6],
          timestamp: 1_756_368_000,
        },
      });
      child.getTeeAttestation = getTeeAttestation;
      const stored = (await client.list?.())?.find(
        (candidate) => candidate.id === child.id
      );
      if (stored) stored.getTeeAttestation = getTeeAttestation;
      return child;
    };

    const verifier = ({
      report,
      attestation,
    }: {
      report: { measurement: number[] };
      attestation: { nonce: string; measurement: `sha256:${string}` };
    }) => {
      if (
        attestation.nonce !== nonceMeasurement &&
        report.measurement[0] === 4
      ) {
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
    const makeRequest = (
      idempotencyKey: string,
      nonce: string,
      tee = "tdx"
    ): WorkspaceForkRequest => {
      const material = {
        checkpoint: checkpoint.checkpoint,
        placement: { kind: "sandbox", sandboxId: sourceEnvironmentId } as const,
        confidential: {
          requested: true as const,
          tee,
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
    const recover = async (request: WorkspaceForkRequest) => {
      await seedLegacyFork(client, request);
      return operations!.fork(request);
    };

    const withoutVerifier = createTangleWorkspaceBranching({
      box: attestationBox,
      client,
      provider,
    });
    await expect(
      withoutVerifier!.fork(
        makeRequest(
          "fork-without-verifier",
          testAttestationNonce("without-verifier")
        )
      )
    ).resolves.toMatchObject({ status: "unknown", retryable: false });

    const acceptedRequest = makeRequest(
      "fork-accepted",
      testAttestationNonce("accepted")
    );
    const accepted = await recover(acceptedRequest);
    expect(accepted.status).toBe("replayed");
    if (accepted.status !== "replayed")
      throw new Error("accepted fork setup failed");
    expect(accepted.environment.confidentialAttestation).toBeDefined();
    expect(
      decodeTangleConfidentialAttestationQuote(
        accepted.environment.confidentialAttestation?.quote
      )
    ).toEqual({
      tee_type: "tdx",
      evidence: [1, 2, 3],
      measurement: [4, 5, 6],
      timestamp: 1_756_368_000,
    });
    expect(
      forkedEnvironmentConfidentialityVerified(
        acceptedRequest,
        accepted.environment,
        () => true
      )
    ).toBe(true);

    const teeRejected = await recover(
      makeRequest(
        "fork-rejected-tee",
        testAttestationNonce("tee-mismatch"),
        "nitro"
      )
    );
    expect(teeRejected.status).toBe("replayed");
    if (teeRejected.status !== "replayed")
      throw new Error("TEE mismatch fork setup failed");
    expect(teeRejected.environment.confidentialAttestation).toBeUndefined();

    const nonceRejected = await recover(
      makeRequest("fork-rejected-nonce", nonceMismatch)
    );
    expect(nonceRejected.status).toBe("replayed");
    if (nonceRejected.status !== "replayed")
      throw new Error("nonce fork setup failed");
    expect(nonceRejected.environment.confidentialRequested).toBe(true);
    expect(nonceRejected.environment.confidentialAttestation).toBeUndefined();

    const missingNonce = await recover(
      makeRequest("fork-rejected-missing-nonce", nonceMissing)
    );
    expect(missingNonce.status).toBe("replayed");
    if (missingNonce.status !== "replayed")
      throw new Error("missing nonce fork setup failed");
    expect(missingNonce.environment.confidentialAttestation).toBeUndefined();

    const measurementRejected = await recover(
      makeRequest("fork-rejected-measurement", nonceMeasurement)
    );
    expect(measurementRejected.status).toBe("replayed");
    if (measurementRejected.status !== "replayed")
      throw new Error("measurement fork setup failed");
    expect(
      measurementRejected.environment.confidentialAttestation
    ).toBeUndefined();
    expect(sha256Bytes(Uint8Array.from([4, 5, 6]))).toBe(
      accepted.environment.confidentialAttestation?.measurement
    );
  });
});

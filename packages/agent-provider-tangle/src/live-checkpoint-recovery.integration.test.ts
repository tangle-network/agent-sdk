import { readFileSync } from "node:fs";
import { Sandbox } from "@tangle-network/sandbox";
import { canonicalCandidateDigest } from "@tangle-network/agent-interface";
import { expect, it } from "vitest";
import { createTangleProvider } from "./index.js";
import { findManagedCheckpoint } from "./tangle-workspace-recovery.js";

// An operator supplies an existing marked checkpoint. This proof only reads it; it never creates, forks or deletes.
const source = process.env.TANGLE_CHECKPOINT_SOURCE_ID;
it.skipIf(!source)("recovers an existing sealed checkpoint through live Sandbox reads", { timeout: 120_000 }, async () => {
  const key = process.env.TANGLE_CHECKPOINT_LOOKUP_KEY;
  const requestDigest = process.env.TANGLE_CHECKPOINT_REQUEST_DIGEST;
  if (!source || !key || !requestDigest?.match(/^sha256:[a-f0-9]{64}$/u)) throw new Error("checkpoint source, key and digest are required");
  const keyFile = process.env.TANGLE_CHECKPOINT_API_KEY_FILE;
  const apiKey = process.env.TANGLE_API_KEY ?? (keyFile ? readFileSync(keyFile, "utf8").trim() : "");
  if (!apiKey) throw new Error("read-only checkpoint proof requires the operator's Sandbox key");
  const client = new Sandbox({ apiKey, baseUrl: process.env.TANGLE_SANDBOX_URL ?? "https://sandbox.tangle.tools" });
  const provider = createTangleProvider({ client });
  const open = () => provider.workspaceBranching!.forEnvironment(source);
  const branching = await open();
  if (!branching) throw new Error("source has no workspace recovery capability");
  const request = { idempotencyKey: key, requestDigest: requestDigest as `sha256:${string}` };
  const answer = await branching.lookupCheckpoint(request);
  expect(answer, JSON.stringify(answer)).toMatchObject({ status: "found" });
  if (answer.status !== "found") throw new Error("checkpoint recovery failed");
  const box = await client.get(source);
  const inventory = await box.listSnapshots();
  const witnesses = inventory.filter((snapshot) => snapshot.tags.includes(`seal.${answer.checkpoint.checkpointId}`));
  expect(witnesses).toHaveLength(1);
  expect(witnesses[0].snapshotId).not.toBe(answer.checkpoint.checkpointId);
  const operation = await box.getSnapshotOperation(key);
  expect(operation).toMatchObject({ outcome: "found", kind: "checkpoint", state: "succeeded", result: { snapshotId: answer.checkpoint.checkpointId, createdAt: answer.checkpoint.createdAt } });
  const restarted = await open();
  expect(await restarted!.lookupCheckpoint(request)).toEqual(answer);
  expect(await findManagedCheckpoint(box, provider.name, answer.checkpoint.checkpointId, answer.checkpoint)).toBe(true);
  // Cleanup has no expected checkpoint binding: reading a seal alias must not authorize its delete or claim it absent.
  expect(await findManagedCheckpoint(box, provider.name, answer.checkpoint.checkpointId)).toBe("unknown");
  const wrongDigest = canonicalCandidateDigest({ mismatched: request.requestDigest });
  expect(await (await open())!.lookupCheckpoint({ ...request, requestDigest: wrongDigest })).toMatchObject({ status: "conflict", existingRequestDigest: request.requestDigest });
  expect(await findManagedCheckpoint(box, provider.name, answer.checkpoint.checkpointId, { ...answer.checkpoint, requestDigest: wrongDigest })).toBe(false);
  expect(await findManagedCheckpoint(box, provider.name, answer.checkpoint.checkpointId, { ...answer.checkpoint, idempotencyKey: `${key}:mismatched-marker` })).toBe(false);
});

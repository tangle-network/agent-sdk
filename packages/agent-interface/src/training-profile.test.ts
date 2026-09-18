import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  type AgentProfile,
  type AgentTrainingReceipt,
  trainedModelIdForArtifact,
} from "./agent-profile.js";
import { canonicalCandidateDigest, sha256Utf8 } from "./agent-candidate-schema-common.js";
import { canonicalAgentProfileDigest } from "./agent-execution-preparation.js";
import { snapshotAgentProfile } from "./agent-profile-snapshot.js";
import {
  agentProfileSchema,
  agentProfileTrainingSchema,
  agentTrainingReceiptSchema,
} from "./profile-schema.js";

function receipt(label = "checkpoint"): AgentTrainingReceipt {
  const tasks = [{ benchmark: "fixture", task: "train", contentDigest: sha256Utf8("train-task") }];
  const artifactDigest = sha256Utf8(label);
  return {
    version: 1,
    parentProfileDigest: sha256Utf8("parent"),
    parentReceiptDigest: null,
    executionRef: sha256Utf8("executor"),
    dataset: { digest: sha256Utf8("dataset"), taskSetDigest: canonicalCandidateDigest(tasks), tasks },
    trainer: { mode: "command", id: "fixture-trainer", revision: sha256Utf8("trainer"), parameters: { epochs: 1 } },
    checkpoint: { artifactDigest, artifactBytes: 10, routerModelId: trainedModelIdForArtifact(artifactDigest), servingDigest: sha256Utf8("serving") },
  };
}

function profile(): AgentProfile {
  const r = receipt();
  return {
    name: "coder", version: "1", harness: "opencode",
    model: { provider: "openai-compat", default: r.checkpoint.routerModelId },
    metadata: { training: { receipt: r, ancestors: [] } },
  };
}

describe("checkpoint-backed profile admission", () => {
  it("requires a receipt for an artifact-addressed trained model", () => {
    const p = profile();
    delete p.metadata;
    assert.equal(agentProfileSchema.safeParse(p).success, false);
    assert.throws(() => snapshotAgentProfile(p));
    p.metadata = { training: {} as never };
    assert.equal(agentProfileSchema.safeParse(p).success, false);
    assert.equal(agentProfileSchema.safeParse({ name: "legacy", model: { default: "base" } }).success, true);
  });

  it("refuses unreceipted trained auxiliary models", () => {
    const id = trainedModelIdForArtifact(sha256Utf8("auxiliary"));
    for (const value of [
      { model: { default: "baseline", small: id } },
      { subagents: { helper: { model: id } } },
      { modes: { helper: { model: id } } },
    ]) assert.equal(agentProfileSchema.safeParse(value).success, false);
  });

  it("requires every checkpoint receipt field", () => {
    for (const field of ["dataset", "parentProfileDigest", "parentReceiptDigest", "executionRef", "trainer", "checkpoint"] as const) {
      const raw = structuredClone(receipt()) as unknown as Record<string, unknown>;
      delete raw[field];
      assert.equal(agentTrainingReceiptSchema.safeParse(raw).success, false, field);
    }
    for (const field of ["artifactDigest", "artifactBytes", "routerModelId", "servingDigest"] as const) {
      const raw = structuredClone(receipt());
      delete (raw.checkpoint as unknown as Record<string, unknown>)[field];
      assert.equal(agentTrainingReceiptSchema.safeParse(raw).success, false, field);
    }
  });

  it("pins artifact dataset and parent in canonical profile identity", () => {
    const original = profile();
    const digest = canonicalAgentProfileDigest(original);
    for (const mutate of [
      (r: AgentTrainingReceipt) => { r.dataset.digest = sha256Utf8("another-dataset"); },
      (r: AgentTrainingReceipt) => { r.parentProfileDigest = sha256Utf8("another-parent"); },
      (r: AgentTrainingReceipt) => {
        r.checkpoint.artifactDigest = sha256Utf8("another-checkpoint");
        r.checkpoint.routerModelId = trainedModelIdForArtifact(r.checkpoint.artifactDigest);
      },
    ]) {
      const changed = structuredClone(original);
      const r = changed.metadata!.training!.receipt;
      mutate(r);
      changed.model!.default = r.checkpoint.routerModelId;
      assert.notEqual(canonicalAgentProfileDigest(changed), digest);
    }
  });

  it("refuses model substitution and a mutable serving alias", () => {
    const p = profile();
    p.model!.default = "some-other-model";
    assert.equal(agentProfileSchema.safeParse(p).success, false);
    const r = receipt();
    r.checkpoint.routerModelId = "fine-tune/latest";
    assert.equal(agentTrainingReceiptSchema.safeParse(r).success, false);
  });

  it("refuses incomplete or altered receipt ancestry", () => {
    const parent = receipt("parent-checkpoint");
    const child = receipt();
    child.parentReceiptDigest = canonicalCandidateDigest(parent);
    assert.equal(agentProfileTrainingSchema.safeParse({ receipt: child, ancestors: [parent] }).success, true);
    assert.equal(agentProfileTrainingSchema.safeParse({ receipt: child, ancestors: [] }).success, false);
    parent.dataset.digest = sha256Utf8("laundered-dataset");
    assert.equal(agentProfileTrainingSchema.safeParse({ receipt: child, ancestors: [parent] }).success, false);
  });

  it("refuses a false task inventory digest duplicate tasks and credential parameters", () => {
    const r = receipt();
    r.dataset.taskSetDigest = sha256Utf8("not-the-inventory");
    assert.equal(agentTrainingReceiptSchema.safeParse(r).success, false);
    r.dataset.tasks.push(r.dataset.tasks[0]!);
    r.dataset.taskSetDigest = canonicalCandidateDigest(r.dataset.tasks);
    assert.equal(agentTrainingReceiptSchema.safeParse(r).success, false);
    const secret = receipt();
    secret.trainer.parameters = { api_key: "not-allowed-even-as-a-public-parameter" };
    assert.equal(agentTrainingReceiptSchema.safeParse(secret).success, false);
  });

  it("detaches and freezes lineage at the existing snapshot boundary", () => {
    const source = profile();
    const snapshot = snapshotAgentProfile(source);
    const before = canonicalAgentProfileDigest(snapshot);
    source.metadata!.training!.receipt.dataset.digest = sha256Utf8("changed-after-admission");
    assert.equal(canonicalAgentProfileDigest(snapshot), before);
    assert(Object.isFrozen(snapshot.metadata!.training!.receipt.dataset.tasks));
    assert.throws(() => snapshot.metadata!.training!.receipt.dataset.tasks.push({ benchmark: "x", task: "x", contentDigest: sha256Utf8("x") }));
  });
});

import { describe, expect, it } from "vitest";
import {
  PARENT_RUN_KEY_ATTRS,
  RUN_KEY_ATTRS,
  RUN_KIND_ATTRS,
  SUBJECT_KEY_ATTRS,
  TANGLE_RUN_ID_CAMEL_KEY,
  TANGLE_RUN_ID_KEY,
  TANGLE_RUN_KIND_KEY,
  TANGLE_RUN_PARENT_ID_KEY,
  TANGLE_SUBJECT_KEY,
  TANGLE_TRIGGER_ID_KEY,
  TANGLE_TRIGGER_KIND_KEY,
  TANGLE_TRIGGER_SOURCE_KEY,
  TANGLE_WORKFLOW_ID_KEY,
  TRIGGER_ID_ATTRS,
  TRIGGER_SOURCE_ATTRS,
  WORKFLOW_MARKER_ATTRS,
} from "../src/index.js";

describe("spine attribute vocabulary", () => {
  it("pins the candidate keys and their priority order", () => {
    // Order matters: run-attrs.ts returns the first matching key, so a reorder
    // is a behavior change and must fail here (these are the exact lists the
    // derivers + reconstruct read).
    expect(RUN_KEY_ATTRS).toEqual(["tangle.run.id", "tangle.runId"]);
    expect(PARENT_RUN_KEY_ATTRS).toEqual([
      "tangle.run.parent_id",
      "tangle.run.parentId",
      "tangle.workflow.parent.run.id",
      "tangle.workflow.run.id",
      "tangle.workflow.runId",
    ]);
    expect(TRIGGER_SOURCE_ATTRS).toEqual([
      "tangle.workflow.trigger.source",
      "tangle.trigger.source",
      "tangle.trigger.kind",
    ]);
    expect(TRIGGER_ID_ATTRS).toEqual([
      "tangle.workflow.trigger.id",
      "tangle.trigger.id",
    ]);
    expect(SUBJECT_KEY_ATTRS).toEqual([
      "tangle.subject.key",
      "tangle.project.name",
      "symphony.issue.identifier",
      "git.repository",
      "service.name",
    ]);
    expect(RUN_KIND_ATTRS).toEqual(["tangle.run.kind"]);
    expect(WORKFLOW_MARKER_ATTRS).toEqual([
      "tangle.workflow.id",
      "tangle.workflowId",
      "tangle.workflow.name",
      "tangle.workflow.run.id",
      "tangle.workflow.runId",
    ]);
  });

  it("freezes the arrays so the shared vocabulary cannot be mutated", () => {
    expect(Object.isFrozen(RUN_KEY_ATTRS)).toBe(true);
    expect(Object.isFrozen(PARENT_RUN_KEY_ATTRS)).toBe(true);
    expect(Object.isFrozen(TRIGGER_SOURCE_ATTRS)).toBe(true);
    expect(Object.isFrozen(TRIGGER_ID_ATTRS)).toBe(true);
    expect(Object.isFrozen(SUBJECT_KEY_ATTRS)).toBe(true);
    expect(Object.isFrozen(RUN_KIND_ATTRS)).toBe(true);
    expect(Object.isFrozen(WORKFLOW_MARKER_ATTRS)).toBe(true);
  });

  it("a writer's primary key is the reader candidate list's first entry (drift guard)", () => {
    // Writer (workflow-trace-emitter) and reader (run-attrs derivers) share one
    // source; the emitter writes these primary keys, the reader candidate lists
    // lead with them.
    expect(RUN_KEY_ATTRS[0]).toBe(TANGLE_RUN_ID_KEY);
    expect(PARENT_RUN_KEY_ATTRS[0]).toBe(TANGLE_RUN_PARENT_ID_KEY);
    expect(TRIGGER_SOURCE_ATTRS[0]).toBe(TANGLE_TRIGGER_SOURCE_KEY);
    expect(TRIGGER_ID_ATTRS[0]).toBe(TANGLE_TRIGGER_ID_KEY);
    expect(SUBJECT_KEY_ATTRS[0]).toBe(TANGLE_SUBJECT_KEY);
    expect(RUN_KIND_ATTRS[0]).toBe(TANGLE_RUN_KIND_KEY);
  });

  it("pins the emitter's actual written keys (camel run id, root workflow id, trigger kind)", () => {
    // These three primary keys are the literal strings the platform emitter
    // stamps; renaming the constant without updating the emitter's column
    // mapping would silently break ingest run_id / workflow rollups.
    expect(TANGLE_RUN_ID_CAMEL_KEY).toBe("tangle.runId");
    expect(TANGLE_WORKFLOW_ID_KEY).toBe("tangle.workflowId");
    expect(TANGLE_TRIGGER_KIND_KEY).toBe("tangle.trigger.kind");
    // The camel run-id is the second run-key candidate; the trigger-kind is the
    // last trigger-source candidate; the workflow id is a workflow marker.
    expect(RUN_KEY_ATTRS).toContain(TANGLE_RUN_ID_CAMEL_KEY);
    expect(TRIGGER_SOURCE_ATTRS).toContain(TANGLE_TRIGGER_KIND_KEY);
    expect(WORKFLOW_MARKER_ATTRS).toContain(TANGLE_WORKFLOW_ID_KEY);
  });
});

/**
 * Spine run/subject/tree + trigger span-attribute vocabulary — the single set of
 * `tangle.*` keys that name a run, its parent, its kind, its trigger, and the
 * durable subject it worked on. Co-located here so the WRITER (the platform
 * workflow-trace-emitter) and the READERS (intelligence-api's run-attrs derivers
 * + reconstruct) key off one source and can never silently drift.
 *
 * Writers emit the PRIMARY keys (`*_KEY`). The ingest reader accepts the wider
 * CANDIDATE lists (`*_ATTRS`) because the emit sites disagree on spelling: the
 * workflow emitter writes camel `tangle.runId`, the agent setup prompt documents
 * dotted `tangle.run.id`. Each candidate list's first entry is a writer primary
 * key, so the drift guard (`spine-attributes.test.ts`) can assert writer/reader
 * agreement.
 *
 * The DERIVATION LOGIC (priority resolution, parent!=own-run guard, run-kind
 * inference, subject `'default'` fallback, `source:id` formatting) lives in
 * intelligence-api's `run-attrs.ts`; only the key constants and candidate lists
 * live here. The foreign subject candidates (`symphony.issue.identifier`,
 * `git.repository`, `service.name`) are members of {@link SUBJECT_KEY_ATTRS}.
 */

/** Primary run-id key writers stamp; first entry of {@link RUN_KEY_ATTRS}. */
export const TANGLE_RUN_ID_KEY = "tangle.run.id";
/** Camel run-id key the workflow emitter actually writes on every span. */
export const TANGLE_RUN_ID_CAMEL_KEY = "tangle.runId";
/** Primary parent-run-id key; first entry of {@link PARENT_RUN_KEY_ATTRS}. */
export const TANGLE_RUN_PARENT_ID_KEY = "tangle.run.parent_id";
/** Primary run-kind key; the sole entry of {@link RUN_KIND_ATTRS}. */
export const TANGLE_RUN_KIND_KEY = "tangle.run.kind";
/** Primary subject key; first entry of {@link SUBJECT_KEY_ATTRS}. */
export const TANGLE_SUBJECT_KEY = "tangle.subject.key";
/** Primary trigger-source key; first entry of {@link TRIGGER_SOURCE_ATTRS}. */
export const TANGLE_TRIGGER_SOURCE_KEY = "tangle.workflow.trigger.source";
/** Trigger-kind key the workflow emitter writes on the root span. */
export const TANGLE_TRIGGER_KIND_KEY = "tangle.trigger.kind";
/** Primary trigger-id key; first entry of {@link TRIGGER_ID_ATTRS}. */
export const TANGLE_TRIGGER_ID_KEY = "tangle.workflow.trigger.id";
/** Workflow-id key the workflow emitter writes on the root span; a
 *  {@link WORKFLOW_MARKER_ATTRS} member. */
export const TANGLE_WORKFLOW_ID_KEY = "tangle.workflowId";

/** Run-id reader candidates, highest priority first. */
export const RUN_KEY_ATTRS: readonly string[] = Object.freeze([
  TANGLE_RUN_ID_KEY,
  TANGLE_RUN_ID_CAMEL_KEY,
]);

/**
 * Parent-run-id reader candidates, highest priority first. After the explicit
 * parent keys come the workflow-run ids, which name a parent only when this span
 * is a distinct child run (the deriver's own-run guard enforces that).
 */
export const PARENT_RUN_KEY_ATTRS: readonly string[] = Object.freeze([
  TANGLE_RUN_PARENT_ID_KEY,
  "tangle.run.parentId",
  "tangle.workflow.parent.run.id",
  "tangle.workflow.run.id",
  "tangle.workflow.runId",
]);

/** Trigger-source reader candidates, highest priority first. */
export const TRIGGER_SOURCE_ATTRS: readonly string[] = Object.freeze([
  TANGLE_TRIGGER_SOURCE_KEY,
  "tangle.trigger.source",
  TANGLE_TRIGGER_KIND_KEY,
]);

/** Trigger-id reader candidates, highest priority first. */
export const TRIGGER_ID_ATTRS: readonly string[] = Object.freeze([
  TANGLE_TRIGGER_ID_KEY,
  "tangle.trigger.id",
]);

/**
 * Subject-key reader candidates, highest priority first: declared subject key /
 * project, else the agent's own work-item identity, else repo, else service. The
 * deriver appends a `'default'` fallback so no run is orphaned.
 */
export const SUBJECT_KEY_ATTRS: readonly string[] = Object.freeze([
  TANGLE_SUBJECT_KEY,
  "tangle.project.name",
  "symphony.issue.identifier",
  "git.repository",
  "service.name",
]);

/** Explicit run-kind reader candidates (exact `workflow`/`consultant`/`session`
 *  wins in the deriver). */
export const RUN_KIND_ATTRS: readonly string[] = Object.freeze([
  TANGLE_RUN_KIND_KEY,
]);

/** Workflow-presence markers — any one present implies a `workflow` run kind. */
export const WORKFLOW_MARKER_ATTRS: readonly string[] = Object.freeze([
  "tangle.workflow.id",
  TANGLE_WORKFLOW_ID_KEY,
  "tangle.workflow.name",
  "tangle.workflow.run.id",
  "tangle.workflow.runId",
]);

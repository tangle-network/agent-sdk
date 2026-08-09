/**
 * Conformance validation — the heart of "ship it and figure out what you got".
 *
 * Given ANY spans, report what can be analysed and what cannot, and WHY. It
 * never throws: a tool that crashes on a foreign trace is useless for the job of
 * reading arbitrary AI systems, so malformed input becomes a finding, not an
 * exception. `null` attributes, missing fields, cyclic parents, a string where
 * an array belongs — all of it is reported.
 *
 * Two outputs, deliberately separate:
 *
 * - `findings` say what is WRONG with the trace, and each message names the
 *   CONSEQUENCE. "missing attribute" tells a producer nothing; "these calls
 *   cannot be priced or compared per model" tells them what they lost.
 * - `capabilities` say what a consumer can DO with the trace, with a reason
 *   whenever the answer is no. A caller decides whether to run an analysis by
 *   reading this list, not by parsing findings.
 *
 * `ok` answers ONE question and it is the question a CI job keys off: is this a
 * trace at all? An export with nothing readable in it — no entries, no entry
 * that parses, no array — is not a trace, and calling it conforming while
 * reporting zero available capabilities is a self-contradiction that turns a
 * red pipeline green. An export whose spans ARE readable is a trace, however
 * poor: the analyses it cannot support are named in `capabilities`, one by one,
 * which is a precise statement where a bare `ok: false` is only a loud one.
 * Severity encodes exactly that split and nothing else — see
 * {@link FindingSeverity}.
 *
 * A reason states ONLY what was measured. Every clause of every reason is
 * phrased from a count this function computed — never from a condition that
 * merely seemed to follow from the branch it sits in. This is the package's
 * whole product: a wrong reason is worse than no reason, because it is acted on.
 * A reason that says "none carry gen_ai.tool.name" while the attribute is
 * sitting on a span, or "every span carries the same iteration" when one span in
 * fifty carries it at all, costs its reader an afternoon and the validator its
 * credibility. Two facts a reason must never conflate: a key that was never
 * emitted, and a key emitted with a value no reader can use.
 *
 * `blocks` connects the two, and it is derived, never guessed: each unavailable
 * capability names the finding codes that CAUSED it, and `blocks` is that map
 * inverted. So a finding never takes credit for breaking something that broke
 * for another reason, and a finding about a defect that cost you nothing
 * measurable carries no `blocks` at all. A duplicated span carrying no usage
 * cannot double-count tokens, and is not allowed to claim it did.
 *
 * Nothing here is a style rule. Every finding either costs a consumer an answer
 * or costs the trace its ability to join another one, and a validator that fails
 * a producer for anything less trains it to ignore the validator.
 */

import {
  ATTR,
  attributeBag,
  BRANCH_ATTR_KEYS,
  COST_ATTR_KEYS,
  firstNumberAttr,
  firstStringAttr,
  hasAttrKey,
  INPUT_TOKEN_ATTR_KEYS,
  ITERATION_ATTR_KEYS,
  LINK_KIND_ATTR,
  MODEL_ATTR_KEYS,
  OUTPUT_TOKEN_ATTR_KEYS,
  readProperty,
  TOOL_NAME_ATTR_KEYS,
} from "./attributes.js";
import { declaredSpanKind, resolveSpanKind } from "./classify.js";
import {
  isW3CSpanId,
  isW3CTraceId,
  SPAN_ID_HEX_LENGTH,
  TRACE_ID_HEX_LENGTH,
} from "./ids.js";
import {
  type ContractSpan,
  type SpanKind,
  SPAN_STATUS_CODES,
  type SpanStatusCode,
} from "./span.js";

/**
 * What a finding says about the INPUT, not how loud it is.
 *
 * - `error` — NOT A TRACE. Not one span could be read, so no analysis of any
 *   kind can run and every capability is unavailable. Only `error` makes
 *   {@link TraceValidation.ok} false.
 * - `warn` — ANALYSABLE BUT DEGRADED. Spans were read, and some measurement is
 *   missing, ambiguous or wrong. Which one is stated by the capability the
 *   finding `blocks`, never by the severity.
 * - `info` — ANALYSABLE, and nothing measurable was lost.
 *
 * Severity is deliberately not a ranking of how bad a defect is, because a
 * ranking would have to be re-litigated for every new code and would still tell
 * a caller nothing actionable. An export whose every parent edge dangles is a
 * real trace holding real token totals with cost roll-up unavailable; an export
 * of three unparseable lines is not a trace at all. A verdict that does not
 * separate those two is worth nothing to the job keying off it.
 */
export type FindingSeverity = "error" | "warn" | "info";

/** Every defect this validator reports. Stable — consumers switch on these. */
export type FindingCode =
  | "invalid-input"
  | "no-spans"
  | "invalid-span"
  | "truncated-input"
  | "duplicate-span-id"
  | "redeclared-span"
  | "non-hex-id"
  | "missing-trace-id"
  | "orphan-parent"
  | "cyclic-parent"
  | "cross-trace-parent"
  | "flat-hierarchy"
  | "invalid-timestamp"
  | "negative-duration"
  | "invalid-status"
  | "unknown-span-kind"
  | "missing-model"
  | "no-usage"
  | "missing-tool-name"
  | "dangling-link";

export interface ConformanceFinding {
  severity: FindingSeverity;
  /** A {@link FindingCode}; typed as `string` so a future code cannot break a consumer's build. */
  code: string;
  /** Names the CONSEQUENCE of the defect, not just the defect. */
  message: string;
  spanIds?: string[];
  /** Capability names this finding makes impossible — only ones actually unavailable. */
  blocks?: string[];
}

/** What a consumer can compute from a trace. */
export type CapabilityName =
  | "token-accounting"
  | "cost-attribution"
  | "tool-usage"
  | "loop-convergence"
  | "tree-comparison"
  | "steering-chain"
  | "latency-analysis";

/** Every {@link CapabilityName}, in the order `validateTraceSpans` reports them. */
export const CAPABILITY_NAMES: readonly CapabilityName[] = Object.freeze([
  "token-accounting",
  "cost-attribution",
  "tool-usage",
  "loop-convergence",
  "tree-comparison",
  "steering-chain",
  "latency-analysis",
]);

export interface Capability {
  name: string;
  available: boolean;
  /** Present whenever `available` is false: what is missing, in the trace's own terms. */
  reason?: string;
}

export interface TraceValidation {
  /**
   * True when the input is a trace: at least one span was readable, so an
   * analysis can run against it. False only when nothing was readable, which is
   * also the only case where every capability is unavailable. Warnings and the
   * unavailable capabilities they cause leave `ok` true — a degraded trace is
   * still a trace, and `capabilities` is where a caller learns what it lost.
   */
  ok: boolean;
  findings: ConformanceFinding[];
  capabilities: Capability[];
}

/** A capability plus the findings that explain it, when it is unavailable. */
interface CapabilityAssessment {
  capability: Capability;
  causes: FindingCode[];
}

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  error: 0,
  warn: 1,
  info: 2,
};

interface LinkView {
  targetSpanId: string | null;
  targetTraceId: string | null;
  kind: string | null;
}

interface SpanView {
  spanId: string;
  traceId: string | null;
  parentSpanId: string | null;
  name: string | null;
  kind: SpanKind;
  declaredRaw: string | null;
  declaredKnown: boolean;
  startTime: string | null;
  endTime: string | null;
  statusCode: string | null;
  attributes: Record<string, unknown>;
  resourceAttributes: Record<string, unknown>;
  links: LinkView[];
  statusValid: boolean;
  startMs: number | null;
  endMs: number | null;
}

/** Every copy of one re-used span id, and how the copies disagree. */
interface SpanConflict {
  /** Field names that differ between copies, e.g. `parent_span_id`. */
  fields: Set<string>;
  copies: SpanView[];
}

/**
 * The fields whose disagreement makes the TREE ambiguous, as opposed to merely
 * making a label ambiguous: two copies of one id under different parents mean
 * the subtree below has two possible homes, and cost cannot be rolled up to
 * either with a straight face.
 */
const STRUCTURAL_IDENTITY_FIELDS: readonly string[] = Object.freeze([
  "trace_id",
  "parent_span_id",
]);

/**
 * How many entries this function will READ from one export.
 *
 * `length` is a number the producer wrote, not a fact about how many spans
 * exist: `new Array(4e9)` is a plain JavaScript value, and a loop that trusts
 * that number either runs for minutes or dies inside an accumulator that cannot
 * hold one entry per index. Both outcomes break the only promise this package
 * makes — it does not throw and it comes back — so the read is bounded and the
 * clipping is REPORTED, never silent: `truncated-input` says how many entries
 * went unread, so a caller learns its totals cover a prefix instead of trusting
 * a number that quietly lost the tail.
 *
 * The bound is an order of magnitude above the largest export a real agent run
 * produces, and at that size the function still returns in well under a second
 * holding a few hundred megabytes of views. Ten times more is seconds and
 * gigabytes, which on a CI runner is the crash this bound exists to prevent.
 */
export const MAX_SPANS_READ = 250_000;

/**
 * Report what these spans can and cannot answer.
 *
 * The parameter is typed as spans for callers that have them, but the
 * implementation trusts nothing: pass a string, an array of `null`, or a trace
 * from a system that never heard of this contract, and you get findings back.
 */
export function validateTraceSpans(
  spans: readonly ContractSpan[],
): TraceValidation {
  const input: unknown = spans;
  if (!Array.isArray(input)) {
    return assemble(
      [
        finding(
          "invalid-input",
          "error",
          "the input is not an array of spans, so this is not a trace: nothing in it can be read, and nothing can be analysed",
        ),
      ],
      unavailableCapabilities("the input is not an array of spans", [
        "invalid-input",
      ]),
      false,
    );
  }
  // Even the array is read defensively: `Array.isArray` is true for a Proxy over
  // an array, whose length and elements are arbitrary code.
  const rawLength = readProperty(input, "length");
  const length =
    typeof rawLength === "number" && Number.isSafeInteger(rawLength) && rawLength > 0
      ? rawLength
      : 0;
  if (length === 0) {
    return assemble(
      [
        finding(
          "no-spans",
          "error",
          "the export contains no spans at all, so this is not a trace: there is nothing to read, and every analysis would report emptiness rather than a measurement",
        ),
      ],
      unavailableCapabilities("the export contains no spans", ["no-spans"]),
      false,
    );
  }

  const findings: ConformanceFinding[] = [];
  const parsed: SpanView[] = [];
  // Two separate bounds, because there are two ways an oversized export ends
  // this function in an exception rather than a verdict. The LOOP is bounded by
  // MAX_SPANS_READ. The RECORD of dropped entries is bounded independently: it
  // is reported as a count plus the sample the message prints, so the array
  // never grows one element per bad entry — an accumulator that tracks the input
  // one-for-one throws on its own past 2^32-1 entries, however short the loop.
  const readCount = Math.min(length, MAX_SPANS_READ);
  let invalidCount = 0;
  const invalidPositions: string[] = [];
  for (let index = 0; index < readCount; index++) {
    const view = readSpan(readProperty(input, String(index)));
    if (view === null) {
      invalidCount++;
      if (invalidPositions.length < SAMPLE_LIMIT) {
        invalidPositions.push(String(index));
      }
    } else parsed.push(view);
  }
  if (length > readCount) {
    findings.push(
      finding(
        "truncated-input",
        "warn",
        `the export declares ${length} entries and at most ${MAX_SPANS_READ} are read in one call, so the last ${length - readCount} were never looked at: every count, total and structural check reported here describes the first ${readCount} entries only, and a span outside them is invisible to all of them — split the export and validate the parts`,
      ),
    );
  }
  // The same defect at two different severities, because it is two different
  // situations. Entries dropped ALONGSIDE readable spans cost the totals what
  // those entries held — a real loss, on a trace that still analyses. Entries
  // dropped when there are no others is a file of garbage lines, and calling
  // that analysable is the lie this severity exists to prevent.
  if (invalidCount > 0) {
    findings.push(
      parsed.length > 0
        ? finding(
            "invalid-span",
            "warn",
            `${invalidCount} entries (at positions ${sampleOf(invalidPositions, invalidCount)}) are not objects carrying a span_id and were dropped, so whatever tokens, cost or outcomes they held are missing from every total`,
          )
        : finding(
            "invalid-span",
            "error",
            // "read from", not "in": when the export was truncated the entries
            // past the bound were never examined, and a count that claims them
            // is a number this function did not measure.
            `not one of the ${invalidCount} entries read from this export is an object carrying a span_id, so no span could be read and this is not a trace`,
          ),
    );
  }
  if (parsed.length === 0) {
    return assemble(
      findings,
      unavailableCapabilities("no entry in the export is a usable span", [
        "invalid-span",
      ]),
      false,
    );
  }

  // One span id is one unit of work, so a second copy of an id is a second
  // DECLARATION of the same span, not a second span. An export assembled from
  // per-round files re-declares the ancestors every round hangs from, and
  // merging those costs nothing: a merged copy is counted once. Copies that
  // DISAGREE are the real defect — then which copy is the span is undecidable,
  // and what it costs depends on what they disagree about.
  const byId = new Map<string, SpanView>();
  const views: SpanView[] = [];
  const conflicts = new Map<string, SpanConflict>();
  const redeclaredIds = new Set<string>();
  for (const view of parsed) {
    const first = byId.get(view.spanId);
    if (first === undefined) {
      byId.set(view.spanId, view);
      views.push(view);
      continue;
    }
    const differing = conflictingFields(first, view);
    if (differing.length === 0) {
      redeclaredIds.add(view.spanId);
      continue;
    }
    const conflict = conflicts.get(view.spanId);
    if (conflict === undefined) {
      conflicts.set(view.spanId, {
        fields: new Set(differing),
        copies: [first, view],
      });
    } else {
      for (const field of differing) conflict.fields.add(field);
      conflict.copies.push(view);
    }
  }

  const conflictIds = [...conflicts.keys()];
  if (conflictIds.length > 0) {
    const fields = [
      ...new Set(
        [...conflicts.values()].flatMap((conflict) => [...conflict.fields]),
      ),
    ].sort();
    findings.push(
      finding(
        "duplicate-span-id",
        "warn",
        // `fields` is the union across every conflicting id, so with more than
        // one id the list is a fact about the SET, not about any single id's
        // copies — and the phrasing has to say which, or a reader goes looking
        // for a `status` disagreement on an id whose copies differ only in name.
        `${conflictIds.length} span ids are declared more than once with different content (${sample(conflictIds)}; ${conflictIds.length === 1 ? "the copies disagree on" : "between them the copies disagree on"} ${fields.join(", ")}), so which copy is the real span is undecidable and any number read off them depends on which copy was seen first`,
        conflictIds,
      ),
    );
  }

  const redeclaredOnlyIds = [...redeclaredIds].filter(
    (spanId) => !conflicts.has(spanId),
  );
  if (redeclaredOnlyIds.length > 0) {
    findings.push(
      finding(
        "redeclared-span",
        "info",
        `${redeclaredOnlyIds.length} span ids are declared more than once with identical content (${sample(redeclaredOnlyIds)}) — the shape an export assembled from per-round files has, where every file re-declares the ancestors it hangs from — and the copies were merged, so nothing is counted twice`,
        redeclaredOnlyIds,
      ),
    );
  }

  const nonHexIds = idsOf(
    views,
    (view) =>
      !isW3CSpanId(view.spanId) ||
      (view.traceId !== null && !isW3CTraceId(view.traceId)),
  );
  if (nonHexIds.length > 0) {
    findings.push(
      finding(
        "non-hex-id",
        "warn",
        `${nonHexIds.length} spans carry ids outside the OTLP encoding — ${TRACE_ID_HEX_LENGTH} lowercase hex characters for trace_id, ${SPAN_ID_HEX_LENGTH} for span_id (${sample(nonHexIds)}) — so this trace cannot be correlated with a W3C traceparent, and every consumer that parses one drops or rejects these spans instead of joining them to the work they caused; derive the wire id with deriveHexId() and keep the readable id as an attribute`,
        nonHexIds,
      ),
    );
  }

  const missingTraceIds = idsOf(views, (view) => view.traceId === null);
  if (missingTraceIds.length > 0) {
    findings.push(
      finding(
        "missing-trace-id",
        "warn",
        `${missingTraceIds.length} spans carry no trace_id, so they cannot be grouped into the run that produced them and are analysed as one anonymous trace`,
        missingTraceIds,
      ),
    );
  }

  const orphanIds = idsOf(
    views,
    (view) => view.parentSpanId !== null && !byId.has(view.parentSpanId),
  );
  if (orphanIds.length > 0) {
    findings.push(
      finding(
        "orphan-parent",
        "warn",
        `${orphanIds.length} spans name a parent_span_id absent from this export (${sample(orphanIds)}), so their subtree cannot be attached and its cost and outcomes never roll up to a run`,
        orphanIds,
      ),
    );
  }

  const cyclicIds = findCyclicSpans(views, byId);
  if (cyclicIds.length > 0) {
    findings.push(
      finding(
        "cyclic-parent",
        "warn",
        `${cyclicIds.length} spans form a parent cycle, so walking the tree would never terminate and nesting cannot be used at all`,
        cyclicIds,
      ),
    );
  }

  const crossTraceIds = idsOf(views, (view) => {
    if (view.parentSpanId === null || view.traceId === null) return false;
    const parent = byId.get(view.parentSpanId);
    return (
      parent !== undefined &&
      parent.traceId !== null &&
      parent.traceId !== view.traceId
    );
  });
  if (crossTraceIds.length > 0) {
    findings.push(
      finding(
        "cross-trace-parent",
        "warn",
        `${crossTraceIds.length} spans name a parent in a different trace, so containment crosses a trace boundary and roll-ups stop at the edge — an edge between traces is causality and belongs in links, not parent_span_id`,
        crossTraceIds,
      ),
    );
  }

  const flat = findFlatHierarchy(views);
  if (flat.spanIds.length > 0) {
    findings.push(
      finding(
        "flat-hierarchy",
        "warn",
        `${flat.spanIds.length} spans across ${flat.traceCount} traces carry no parent edge at all, so model calls, tool calls and rounds cannot be attributed to the work that produced them — every span reads as its own run`,
        flat.spanIds,
      ),
    );
  }

  const invalidTimeIds = idsOf(
    views,
    (view) => view.startMs === null || view.endMs === null,
  );
  if (invalidTimeIds.length > 0) {
    findings.push(
      finding(
        "invalid-timestamp",
        "warn",
        `${invalidTimeIds.length} spans have an unparseable start_time or end_time, so their duration is unknown and they drop out of every latency and critical-path number`,
        invalidTimeIds,
      ),
    );
  }

  const negativeDurationIds = idsOf(
    views,
    (view) =>
      view.startMs !== null && view.endMs !== null && view.endMs < view.startMs,
  );
  if (negativeDurationIds.length > 0) {
    findings.push(
      finding(
        "negative-duration",
        "warn",
        `${negativeDurationIds.length} spans end before they start, so any duration taken from them is negative and every latency aggregate containing them is wrong`,
        negativeDurationIds,
      ),
    );
  }

  const invalidStatusIds = idsOf(views, (view) => !view.statusValid);
  if (invalidStatusIds.length > 0) {
    findings.push(
      finding(
        "invalid-status",
        "warn",
        `${invalidStatusIds.length} spans carry no recognised status code, so failures inside them read as unset and any error rate understates what happened`,
        invalidStatusIds,
      ),
    );
  }

  const unknownKindIds = idsOf(
    views,
    (view) => view.declaredRaw !== null && !view.declaredKnown,
  );
  if (unknownKindIds.length > 0) {
    const declared = [
      ...new Set(
        views
          .filter((view) => view.declaredRaw !== null && !view.declaredKnown)
          .map((view) => view.declaredRaw as string),
      ),
    ];
    findings.push(
      finding(
        "unknown-span-kind",
        "info",
        `${unknownKindIds.length} spans declare a span kind outside the contract vocabulary (${sample(declared)}), so they are analysed as UNKNOWN and left out of the LLM and tool breakdowns`,
        unknownKindIds,
      ),
    );
  }

  const llmViews = views.filter((view) => view.kind === "LLM");
  const toolViews = views.filter((view) => view.kind === "TOOL");

  // Each of these names an attribute a span did not yield a value for, and a
  // producer reads the message as an instruction. So it distinguishes the key
  // never being emitted from the key arriving with a value no reader can use:
  // told "carry no gen_ai.request.model" while the key is right there holding
  // an empty string, a producer goes looking for an emit bug that does not exist.
  const missingModelViews = llmViews.filter(
    (view) => firstStringAttr(view.attributes, MODEL_ATTR_KEYS) === undefined,
  );
  if (missingModelViews.length > 0) {
    findings.push(
      finding(
        "missing-model",
        "warn",
        `${missingModelViews.length} LLM spans carry no usable ${ATTR.model} (or any accepted alias)${unusableSuffix(missingModelViews, MODEL_ATTR_KEYS, firstStringAttr, "a non-empty string")}, so those calls cannot be priced and no per-model comparison can include them`,
        missingModelViews.map((view) => view.spanId),
      ),
    );
  }

  const noUsageViews = llmViews.filter((view) => !hasUsage(view));
  if (noUsageViews.length > 0) {
    findings.push(
      finding(
        "no-usage",
        "warn",
        `${noUsageViews.length} LLM spans carry no usable ${ATTR.inputTokens} or ${ATTR.outputTokens} (or any accepted alias)${unusableSuffix(noUsageViews, USAGE_ATTR_KEYS, firstNumberAttr, "a finite number")}, so token accounting silently omits them and every total reads lower than the run actually cost`,
        noUsageViews.map((view) => view.spanId),
      ),
    );
  }

  const missingToolNameViews = toolViews.filter(
    (view) => firstStringAttr(view.attributes, TOOL_NAME_ATTR_KEYS) === undefined,
  );
  if (missingToolNameViews.length > 0) {
    findings.push(
      finding(
        "missing-tool-name",
        "warn",
        `${missingToolNameViews.length} TOOL spans carry no usable ${ATTR.toolName} (or any accepted alias)${unusableSuffix(missingToolNameViews, TOOL_NAME_ATTR_KEYS, firstStringAttr, "a non-empty string")}, so the tool-usage breakdown cannot say which tool ran`,
        missingToolNameViews.map((view) => view.spanId),
      ),
    );
  }

  let linkCount = 0;
  let resolvedLinkCount = 0;
  const danglingLinkSpanIds: string[] = [];
  for (const view of views) {
    let dangling = false;
    for (const link of view.links) {
      linkCount++;
      if (link.targetSpanId !== null && byId.has(link.targetSpanId)) {
        resolvedLinkCount++;
      } else {
        dangling = true;
      }
    }
    if (dangling) danglingLinkSpanIds.push(view.spanId);
  }
  const danglingLinkCount = linkCount - resolvedLinkCount;
  if (danglingLinkCount > 0) {
    findings.push(
      finding(
        "dangling-link",
        "warn",
        `${danglingLinkCount} span links are malformed or point at span ids absent from this export, so the steering chain breaks there and round-to-round causality cannot be followed past it`,
        danglingLinkSpanIds,
      ),
    );
  }

  // A conflicting duplicate only BLOCKS what it actually corrupts. Copies that
  // report the same token counts leave the token total exactly right however
  // else they disagree; copies that agree on where they sit in the tree leave
  // the cost roll-up exactly right. Blaming a duplicate for a number it did not
  // move is how a validator teaches producers to ignore it.
  const conflictList = [...conflicts.values()];
  const usageConflictCount = conflictList.filter((conflict) =>
    copiesDisagree(conflict.copies, usageSignature),
  ).length;
  const costConflictCount = conflictList.filter(
    (conflict) =>
      copiesDisagree(conflict.copies, costSignature) ||
      STRUCTURAL_IDENTITY_FIELDS.some((field) => conflict.fields.has(field)),
  ).length;

  const capabilities = computeCapabilities({
    views,
    toolViews,
    usageConflictCount,
    costConflictCount,
    orphanCount: orphanIds.length,
    cyclicCount: cyclicIds.length,
    crossTraceCount: crossTraceIds.length,
    flatCount: flat.spanIds.length,
    invalidTimeCount: invalidTimeIds.length,
    negativeDurationCount: negativeDurationIds.length,
    linkCount,
    resolvedLinkCount,
  });
  return assemble(findings, capabilities, views.length > 0);
}

interface CapabilityInput {
  views: SpanView[];
  toolViews: SpanView[];
  /** Duplicate ids whose copies report DIFFERENT token counts. */
  usageConflictCount: number;
  /** Duplicate ids whose copies report a different cost, or sit in different places in the tree. */
  costConflictCount: number;
  orphanCount: number;
  cyclicCount: number;
  crossTraceCount: number;
  flatCount: number;
  invalidTimeCount: number;
  negativeDurationCount: number;
  linkCount: number;
  resolvedLinkCount: number;
}

function computeCapabilities(input: CapabilityInput): CapabilityAssessment[] {
  const usageEvidence = attrEvidence(
    input.views,
    USAGE_ATTR_KEYS,
    firstNumberAttr,
  );
  const costEvidence = attrEvidence(input.views, COST_ATTR_KEYS, firstNumberAttr);
  const modelEvidence = attrEvidence(input.views, MODEL_ATTR_KEYS, firstStringAttr);
  const iterationEvidence = attrEvidence(
    input.views,
    ITERATION_ATTR_KEYS,
    firstNumberAttr,
  );
  // Read for the one question the union answers honestly: is any branch signal
  // present at all. How MANY arms there are is a per-key question — see
  // BRANCH_ATTR_KEYS and {@link branchDimensions}.
  const branchEvidence = attrEvidence(
    input.views,
    BRANCH_ATTR_KEYS,
    firstStringAttr,
  );
  const usageCount = usageEvidence.readable;
  const costCount = costEvidence.readable;
  const modelCount = modelEvidence.readable;

  const branchDimensions = BRANCH_DIMENSIONS.map((keys) => ({
    key: keys[0] as string,
    keys,
    evidence: attrEvidence(input.views, keys, firstStringAttr),
    values: new Set<string>(),
  }));
  const iterations = new Set<number>();
  for (const view of input.views) {
    const iteration = firstNumberAttr(view.attributes, ITERATION_ATTR_KEYS);
    if (iteration !== undefined) iterations.add(iteration);
    for (const dimension of branchDimensions) {
      const branch = firstStringAttr(view.attributes, dimension.keys);
      if (branch !== undefined) dimension.values.add(branch);
    }
  }

  // A parent edge that does not attach is a cost roll-up that does not attach:
  // spend below it can no longer be charged to the run that authorised it.
  const structural: Array<{ code: FindingCode; phrase: string }> = [];
  if (input.costConflictCount > 0) {
    structural.push({
      code: "duplicate-span-id",
      phrase: `${input.costConflictCount} span ids whose copies report a different cost or sit in a different place in the tree`,
    });
  }
  if (input.orphanCount > 0) {
    structural.push({
      code: "orphan-parent",
      phrase: `${input.orphanCount} spans whose parent is absent`,
    });
  }
  if (input.cyclicCount > 0) {
    structural.push({
      code: "cyclic-parent",
      phrase: `${input.cyclicCount} spans in a parent cycle`,
    });
  }
  if (input.crossTraceCount > 0) {
    structural.push({
      code: "cross-trace-parent",
      phrase: `${input.crossTraceCount} spans whose parent is in another trace`,
    });
  }
  if (input.flatCount > 0) {
    structural.push({
      code: "flat-hierarchy",
      phrase: `${input.flatCount} spans with no parent edge at all`,
    });
  }

  const tokenAccounting =
    usageCount === 0
      ? unavailable(
          "token-accounting",
          absentAttrReason(
            usageEvidence,
            `${ATTR.inputTokens} or ${ATTR.outputTokens} (or any accepted alias)`,
            "a finite number",
          ),
          ["no-usage"],
        )
      : input.usageConflictCount > 0
        ? unavailable(
            "token-accounting",
            `${input.usageConflictCount} span ids are declared more than once by copies reporting different token counts, so which count to sum is undecidable`,
            ["duplicate-span-id"],
          )
        : available("token-accounting");

  // Deriving a cost is one multiplication on ONE span: a rate looked up from
  // that span's model, times that span's tokens. So the question the reason
  // answers is per span and is measured per span. Two independent totals cannot
  // answer it — a model on span 2 and token counts on span 3 satisfy both counts
  // and give a price table nothing to multiply, and the trace is then told a
  // downstream table closes a gap that no table can close.
  const pricedCount = input.views.filter(
    (view) =>
      firstStringAttr(view.attributes, MODEL_ATTR_KEYS) !== undefined &&
      firstNumberAttr(view.attributes, USAGE_ATTR_KEYS) !== undefined,
  ).length;

  // Cost is absent for one of two different reasons, and they blame different
  // findings. If model and tokens ARE there on the same span, nothing is broken
  // — the trace just never priced itself, and a price table downstream closes
  // the gap; no finding may claim credit for that. If they are NOT, the
  // derivation route is shut too, and the findings that named the missing halves
  // are the cause.
  const derivationGaps: string[] = [];
  const costCauses: FindingCode[] = [];
  if (modelCount === 0) {
    derivationGaps.push(
      absentAttrReason(
        modelEvidence,
        `${ATTR.model} (or any accepted alias)`,
        "a non-empty string",
      ),
    );
    costCauses.push("missing-model");
  }
  if (usageCount === 0) {
    derivationGaps.push(
      absentAttrReason(
        usageEvidence,
        `${ATTR.inputTokens} or ${ATTR.outputTokens} (or any accepted alias)`,
        "a finite number",
      ),
    );
    costCauses.push("no-usage");
  }
  if (derivationGaps.length === 0 && pricedCount === 0) {
    // Both halves exist and never meet. Neither absence reason above is true
    // here, so the gap is stated as the per-span fact that actually shuts the
    // route, and both findings that named a half are the cause.
    derivationGaps.push(
      `${ATTR.model} (or an accepted alias) is present on ${spanCount(modelCount)} and ${ATTR.inputTokens} or ${ATTR.outputTokens} (or an accepted alias) is present on ${spanCount(usageCount)}, but the two never meet on one span, so a price table has no row to multiply`,
    );
    costCauses.push("missing-model", "no-usage");
  }
  const costAttribution =
    costCount === 0
      ? unavailable(
          "cost-attribution",
          absentAttrReason(
            costEvidence,
            `${ATTR.costUsd} (or any accepted alias)`,
            "a finite number",
          ) +
            (derivationGaps.length === 0
              ? "; model and token counts are present, so a price table applied downstream could still derive it"
              : `, and it cannot be derived downstream either: ${derivationGaps.join("; ")}`),
          costCauses,
        )
      : structural.length > 0
        ? unavailable(
            "cost-attribution",
            `the span tree does not attach (${structural.map((entry) => entry.phrase).join(", ")}), so spend cannot roll up to the run that authorised it`,
            structural.map((entry) => entry.code),
          )
        : available("cost-attribution");

  // A tool name on a span that is not analysed as a tool call is the case that
  // makes "none carry gen_ai.tool.name" a lie, so it is measured rather than
  // assumed: a declared kind beats inference in resolveSpanKind, so a producer
  // that labels its tool spans LLM loses the whole breakdown while the attribute
  // it was told to emit is right there.
  const toolNamedViews = input.views.filter(
    (view) => firstStringAttr(view.attributes, TOOL_NAME_ATTR_KEYS) !== undefined,
  );
  const toolNameEvidence = attrEvidence(
    input.views,
    TOOL_NAME_ATTR_KEYS,
    firstStringAttr,
  );
  // Scoped to the TOOL spans, because the branch below speaks about THEM: the
  // all-views count would let a tool name on some other span answer for theirs.
  const namedToolEvidence = attrEvidence(
    input.toolViews,
    TOOL_NAME_ATTR_KEYS,
    firstStringAttr,
  );
  const toolUsage =
    input.toolViews.length === 0
      ? unavailable(
          "tool-usage",
          noToolSpanReason(toolNamedViews, toolNameEvidence),
          [],
        )
      : namedToolEvidence.readable === 0
        ? unavailable(
            "tool-usage",
            `all ${input.toolViews.length} TOOL spans lack a usable ${ATTR.toolName} (or any accepted alias)${namedToolEvidence.unreadable > 0 ? ` — the key is present on ${spanCount(namedToolEvidence.unreadable)} of them with a value that is not a non-empty string` : ""}, so usage cannot be broken down by tool`,
            ["missing-tool-name"],
          )
        : available("tool-usage");

  const loopConvergence =
    iterations.size === 0
      ? unavailable(
          "loop-convergence",
          // ITERATION_ATTR_KEYS is exactly this one key, so naming it alone is
          // the whole truth and no alias caveat belongs here. A test pins the
          // list, so adding an alias fails until this text admits it.
          absentAttrReason(iterationEvidence, ATTR.iteration, "a finite number"),
          [],
        )
      : iterations.size === 1
        ? unavailable(
            "loop-convergence",
            `${ATTR.iteration} is present on ${spanCount(iterationEvidence.readable)} and always has the value ${[...iterations][0]}, so there is no round-over-round change to measure`,
            [],
          )
        : available("loop-convergence");

  // A second distinct value on EITHER key is a second arm, so each key decides
  // on its own. Asking the two together — first match wins — makes the arms of
  // one branch indistinguishable exactly when there is something to compare,
  // and then reports "always names the same branch" about spans that named two.
  const treeComparison = branchDimensions.some(
    (dimension) => dimension.values.size >= 2,
  )
    ? available("tree-comparison")
    : branchDimensions.every((dimension) => dimension.values.size === 0)
      ? unavailable(
          "tree-comparison",
          absentAttrReason(
            branchEvidence,
            `${ATTR.branchId} or ${ATTR.branchArm}`,
            "a non-empty string",
          ),
          [],
        )
      : unavailable(
          "tree-comparison",
          `${branchDimensions.map(branchDimensionClause).join("; ")}, so there is no sibling arm to compare against`,
          [],
        );

  const steeringChain =
    input.linkCount === 0
      ? unavailable(
          "steering-chain",
          "no spans carry links, so causality between rounds was never recorded",
          [],
        )
      : input.resolvedLinkCount === 0
        ? unavailable(
            "steering-chain",
            `all ${input.linkCount} span links are malformed or point at spans absent from this export`,
            ["dangling-link"],
          )
        : available("steering-chain");

  const timingProblems: string[] = [];
  const timingCauses: FindingCode[] = [];
  if (input.invalidTimeCount > 0) {
    timingProblems.push(
      `${input.invalidTimeCount} spans have an unparseable start_time or end_time`,
    );
    timingCauses.push("invalid-timestamp");
  }
  if (input.negativeDurationCount > 0) {
    timingProblems.push(
      `${input.negativeDurationCount} spans end before they start`,
    );
    timingCauses.push("negative-duration");
  }
  const latencyAnalysis =
    timingProblems.length === 0
      ? available("latency-analysis")
      : unavailable(
          "latency-analysis",
          timingProblems.join("; "),
          timingCauses,
        );

  return [
    tokenAccounting,
    costAttribution,
    toolUsage,
    loopConvergence,
    treeComparison,
    steeringChain,
    latencyAnalysis,
  ];
}

/**
 * @param analysable Whether at least one span was READ — the measured fact the
 * verdict rests on, passed in rather than re-derived, because only the caller
 * knows how many of its entries survived parsing.
 */
function assemble(
  findings: ConformanceFinding[],
  assessments: CapabilityAssessment[],
  analysable: boolean,
): TraceValidation {
  // Invert cause -> capability into finding -> blocks. A capability lost for a
  // reason no finding describes simply blames nobody.
  const blocksByCode = new Map<string, string[]>();
  for (const assessment of assessments) {
    if (assessment.capability.available) continue;
    for (const code of assessment.causes) {
      const existing = blocksByCode.get(code);
      if (existing === undefined) blocksByCode.set(code, [assessment.capability.name]);
      else existing.push(assessment.capability.name);
    }
  }
  for (const entry of findings) {
    const blocks = blocksByCode.get(entry.code);
    if (blocks !== undefined && blocks.length > 0) entry.blocks = [...blocks];
  }
  findings.sort(
    (left, right) =>
      SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
      left.code.localeCompare(right.code),
  );
  return {
    // Two statements of one rule, and both are required. `analysable` is the
    // measured fact — a span was read — and the severity scan is what keeps a
    // future `error` code, added by someone who never read this function, from
    // reporting "not a trace" and `ok: true` in the same object.
    ok: analysable && findings.every((entry) => entry.severity !== "error"),
    findings,
    capabilities: assessments.map((assessment) => assessment.capability),
  };
}

/**
 * Every field is read through {@link readProperty}, never with a bare property
 * access: the argument is whatever a caller passed, and a getter or Proxy trap
 * on it can throw. This function is the ingest boundary, so a value that cannot
 * be read has to become an absent field here, not an exception three frames up.
 */
function readSpan(raw: unknown): SpanView | null {
  if (!isRecord(raw)) return null;
  const spanId = nonEmptyString(readProperty(raw, "span_id"));
  if (spanId === null) return null;

  const declared = declaredSpanKind(raw);
  const startTime = readProperty(raw, "start_time");
  const endTime = readProperty(raw, "end_time");
  const statusCode = statusCodeOf(readProperty(raw, "status"));
  const resource = readProperty(raw, "resource");
  return {
    spanId,
    traceId: nonEmptyString(readProperty(raw, "trace_id")),
    parentSpanId: nonEmptyString(readProperty(raw, "parent_span_id")),
    name: nonEmptyString(readProperty(raw, "name")),
    kind: resolveSpanKind(raw),
    declaredRaw: declared.raw,
    declaredKnown: declared.kind !== null,
    startTime: nonEmptyString(startTime),
    endTime: nonEmptyString(endTime),
    statusCode,
    attributes: attributeBag(readProperty(raw, "attributes")),
    resourceAttributes: attributeBag(readProperty(resource, "attributes")),
    links: readLinks(readProperty(raw, "links")),
    statusValid:
      statusCode !== null &&
      SPAN_STATUS_CODES.includes(statusCode as SpanStatusCode),
    startMs: parseTime(startTime),
    endMs: parseTime(endTime),
  };
}

/**
 * A links field of any shape. A non-array `links`, or an array whose iteration
 * itself fails, is an unfollowable edge: counting it as one dangling link
 * reports the damage instead of hiding it.
 */
function readLinks(linksField: unknown): LinkView[] {
  const unfollowable: LinkView[] = [
    { targetSpanId: null, targetTraceId: null, kind: null },
  ];
  if (linksField === undefined) return [];
  if (!Array.isArray(linksField)) return unfollowable;
  try {
    return linksField.map(readLink);
  } catch {
    return unfollowable;
  }
}

function readLink(raw: unknown): LinkView {
  if (!isRecord(raw)) {
    return { targetSpanId: null, targetTraceId: null, kind: null };
  }
  return {
    targetSpanId: nonEmptyString(readProperty(raw, "span_id")),
    targetTraceId: nonEmptyString(readProperty(raw, "trace_id")),
    kind: nonEmptyString(
      readProperty(attributeBag(readProperty(raw, "attributes")), LINK_KIND_ATTR),
    ),
  };
}

/**
 * How two declarations of ONE span id disagree, as OTLP field names; empty when
 * they are the same declaration written twice.
 *
 * Comparison is on the INTERPRETED value of each field, not the raw JSON, so a
 * producer that writes `parent_span_id: null` and one that omits it are not
 * accused of conflicting — both mean "root", and the contract reads them the
 * same way.
 */
function conflictingFields(left: SpanView, right: SpanView): string[] {
  const fields: string[] = [];
  if (left.traceId !== right.traceId) fields.push("trace_id");
  if (left.parentSpanId !== right.parentSpanId) fields.push("parent_span_id");
  if (left.name !== right.name) fields.push("name");
  if (left.declaredRaw !== right.declaredRaw || left.kind !== right.kind) {
    fields.push("kind");
  }
  if (left.startTime !== right.startTime) fields.push("start_time");
  if (left.endTime !== right.endTime) fields.push("end_time");
  if (left.statusCode !== right.statusCode) fields.push("status");
  if (!deepEqual(left.attributes, right.attributes, 0)) {
    fields.push("attributes");
  }
  if (!deepEqual(left.resourceAttributes, right.resourceAttributes, 0)) {
    fields.push("resource");
  }
  if (!sameLinks(left.links, right.links)) fields.push("links");
  return fields;
}

function sameLinks(left: LinkView[], right: LinkView[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const a = left[index] as LinkView;
    const b = right[index] as LinkView;
    if (
      a.targetSpanId !== b.targetSpanId ||
      a.targetTraceId !== b.targetTraceId ||
      a.kind !== b.kind
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Depth is capped rather than tracking visited pairs: an attribute bag that
 * points at itself is legal JavaScript and reaches this function, and a walk
 * that recursed into it would hang the process. Past the cap the values are
 * reported as different, which is the safe direction — a conflict is a finding,
 * and a wrongly-merged span would be silent.
 *
 * A comparison that cannot be PERFORMED — a bag whose keys or values throw when
 * read — takes the same direction, for the same reason.
 */
const MAX_COMPARE_DEPTH = 12;

function deepEqual(left: unknown, right: unknown, depth: number): boolean {
  if (Object.is(left, right)) return true;
  if (depth >= MAX_COMPARE_DEPTH) return false;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  const leftIsArray = Array.isArray(left);
  if (leftIsArray !== Array.isArray(right)) return false;
  if (leftIsArray) {
    const a = left as unknown[];
    const b = right as unknown[];
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) {
      if (!deepEqual(a[index], b[index], depth + 1)) return false;
    }
    return true;
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = ownKeys(a);
  const otherKeys = ownKeys(b);
  if (keys === null || otherKeys === null) return false;
  if (keys.length !== otherKeys.length) return false;
  for (const key of keys) {
    if (!hasOwn(b, key)) return false;
    if (!deepEqual(readProperty(a, key), readProperty(b, key), depth + 1)) {
      return false;
    }
  }
  return true;
}

/** Own enumerable keys, or `null` when the object refuses to enumerate. */
function ownKeys(value: object): string[] | null {
  try {
    return Object.keys(value);
  } catch {
    return null;
  }
}

function hasOwn(value: object, key: string): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(value, key);
  } catch {
    return false;
  }
}

/**
 * Spans in a trace that has TWO OR MORE spans and not a single parent edge.
 * One span with no parent is a root; a whole export with no parent edges is a
 * producer that never recorded nesting.
 */
function findFlatHierarchy(views: SpanView[]): {
  spanIds: string[];
  traceCount: number;
} {
  const byTrace = new Map<string, SpanView[]>();
  for (const view of views) {
    const key = view.traceId ?? "";
    const group = byTrace.get(key);
    if (group === undefined) byTrace.set(key, [view]);
    else group.push(view);
  }
  const spanIds: string[] = [];
  let traceCount = 0;
  for (const group of byTrace.values()) {
    if (group.length < 2) continue;
    if (group.some((view) => view.parentSpanId !== null)) continue;
    traceCount++;
    for (const view of group) spanIds.push(view.spanId);
  }
  return { spanIds, traceCount };
}

/**
 * Spans whose parent chain loops back on itself, including a span that is its
 * own parent. Walks iteratively with a three-state mark so a cycle terminates
 * the walk instead of hanging the process.
 */
function findCyclicSpans(
  views: SpanView[],
  byId: Map<string, SpanView>,
): string[] {
  const VISITING = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  const cyclic = new Set<string>();

  for (const start of views) {
    if (state.get(start.spanId) === DONE) continue;
    const path: string[] = [];
    let current: SpanView | undefined = start;
    while (current !== undefined) {
      const mark = state.get(current.spanId);
      if (mark === VISITING) {
        // Everything from the first occurrence onwards is on the cycle.
        const from = path.indexOf(current.spanId);
        if (from >= 0) for (const id of path.slice(from)) cyclic.add(id);
        break;
      }
      if (mark === DONE) break;
      state.set(current.spanId, VISITING);
      path.push(current.spanId);
      current =
        current.parentSpanId === null
          ? undefined
          : byId.get(current.parentSpanId);
    }
    for (const id of path) state.set(id, DONE);
  }
  return views
    .filter((view) => cyclic.has(view.spanId))
    .map((view) => view.spanId);
}

/**
 * Every key a token count can arrive under, input or output. Concatenated
 * because "does this span carry usage at all" is one question: a span with only
 * an output count still carries usage.
 */
const USAGE_ATTR_KEYS: readonly string[] = Object.freeze([
  ...INPUT_TOKEN_ATTR_KEYS,
  ...OUTPUT_TOKEN_ATTR_KEYS,
]);

/**
 * Each branch key as a candidate list of its own — the opposite of
 * {@link USAGE_ATTR_KEYS}, and for the opposite reason. Token keys are
 * spellings of one measurement, so reading them together is the whole question.
 * Branch keys are separate measurements, so reading them together destroys the
 * one that answers second. Derived from {@link BRANCH_ATTR_KEYS} so a key added
 * there becomes a dimension here rather than being silently swallowed by the
 * first match.
 */
const BRANCH_DIMENSIONS: readonly (readonly string[])[] = Object.freeze(
  BRANCH_ATTR_KEYS.map((key) => Object.freeze([key]) as readonly string[]),
);

/**
 * What the trace actually says about one attribute: how many spans carry a
 * value a reader can USE, and how many carry the key with a value it cannot.
 * The second number is the whole point — it is the difference between "your
 * producer never emitted this" and "your producer emitted it as the string
 * n/a", which are opposite bugs with opposite fixes.
 */
interface AttrEvidence {
  readable: number;
  unreadable: number;
}

function attrEvidence(
  views: SpanView[],
  keys: readonly string[],
  read: (
    attributes: Record<string, unknown>,
    keys: readonly string[],
  ) => string | number | undefined,
): AttrEvidence {
  let readable = 0;
  let unreadable = 0;
  for (const view of views) {
    if (read(view.attributes, keys) !== undefined) readable++;
    else if (hasAttrKey(view.attributes, keys)) unreadable++;
  }
  return { readable, unreadable };
}

/**
 * The reason nothing usable was found under an attribute — stated as whichever
 * of the two facts the evidence supports, never as the one that reads better.
 *
 * `keyPhrase` names every key that was searched; `valueKind` names what a usable
 * value would have been, so a producer that emitted the key can see immediately
 * that the KEY is not the problem.
 */
function absentAttrReason(
  evidence: AttrEvidence,
  keyPhrase: string,
  valueKind: string,
): string {
  if (evidence.unreadable === 0) return `no spans carry ${keyPhrase}`;
  return `no spans carry a usable ${keyPhrase} — the key is present on ${spanCount(evidence.unreadable)} with a value that is not ${valueKind}`;
}

/** `1 span` / `4 spans`, so a reason reads as English at either count. */
function spanCount(count: number): string {
  return count === 1 ? "1 span" : `${count} spans`;
}

/**
 * The parenthetical a finding adds when the spans it names DID emit the key and
 * the value is what a reader rejected; empty when the key is simply absent, so
 * the message never claims a diagnosis it did not measure.
 */
function unusableSuffix(
  views: SpanView[],
  keys: readonly string[],
  read: (
    attributes: Record<string, unknown>,
    keys: readonly string[],
  ) => string | number | undefined,
  valueKind: string,
): string {
  const evidence = attrEvidence(views, keys, read);
  if (evidence.unreadable === 0) return "";
  return ` (on ${spanCount(evidence.unreadable)} of them the key is present but its value is not ${valueKind})`;
}

/**
 * Why a trace with no TOOL-kind span cannot be broken down by tool.
 *
 * Three genuinely different traces reach here and only one of them means "no
 * tool calls were recorded", so the reason distinguishes them by counting rather
 * than by asserting the tidy case.
 */
function noToolSpanReason(
  toolNamedViews: SpanView[],
  evidence: AttrEvidence,
): string {
  if (toolNamedViews.length === 0) {
    return `${absentAttrReason(evidence, `${ATTR.toolName} (or any accepted alias)`, "a non-empty string")}, and no span resolves to kind TOOL`;
  }
  const kinds = [...new Set(toolNamedViews.map((view) => view.kind))].sort();
  const declaredOverride = toolNamedViews.every((view) => view.declaredKnown);
  return (
    `no spans resolve to kind TOOL, though ${ATTR.toolName} (or an accepted alias) is present on ${spanCount(toolNamedViews.length)} — analysed as ${kinds.join(", ")}` +
    (declaredOverride
      ? ", because each of those spans declares that kind and a declared kind wins over inference"
      : "") +
    ", so no span is counted as a tool call"
  );
}

/**
 * What ONE branch key says, when no key says enough to compare arms. Each
 * clause is that key's own count: either it named nothing, or it named one arm
 * on a counted number of spans. Neither clause borrows the other key's evidence,
 * which is the entire point of splitting them.
 */
function branchDimensionClause(dimension: {
  key: string;
  evidence: AttrEvidence;
  values: Set<string>;
}): string {
  if (dimension.values.size === 0) {
    return absentAttrReason(dimension.evidence, dimension.key, "a non-empty string");
  }
  return `${dimension.key} is present on ${spanCount(dimension.evidence.readable)} and always names ${[...dimension.values][0]}`;
}

function hasUsage(view: SpanView): boolean {
  return (
    firstNumberAttr(view.attributes, INPUT_TOKEN_ATTR_KEYS) !== undefined ||
    firstNumberAttr(view.attributes, OUTPUT_TOKEN_ATTR_KEYS) !== undefined
  );
}

/** The tokens a copy reports; `-` where it reports none. */
function usageSignature(view: SpanView): string {
  const input = firstNumberAttr(view.attributes, INPUT_TOKEN_ATTR_KEYS);
  const output = firstNumberAttr(view.attributes, OUTPUT_TOKEN_ATTR_KEYS);
  return `${input ?? "-"}/${output ?? "-"}`;
}

/** The cost a copy reports; `-` where it reports none. */
function costSignature(view: SpanView): string {
  return `${firstNumberAttr(view.attributes, COST_ATTR_KEYS) ?? "-"}`;
}

function copiesDisagree(
  copies: SpanView[],
  signature: (view: SpanView) => string,
): boolean {
  const first = signature(copies[0] as SpanView);
  return copies.some((copy) => signature(copy) !== first);
}

function idsOf(
  views: SpanView[],
  predicate: (view: SpanView) => boolean,
): string[] {
  return views.filter(predicate).map((view) => view.spanId);
}

function finding(
  code: FindingCode,
  severity: FindingSeverity,
  message: string,
  spanIds?: string[],
): ConformanceFinding {
  const entry: ConformanceFinding = { severity, code, message };
  if (spanIds !== undefined && spanIds.length > 0) entry.spanIds = [...spanIds];
  return entry;
}

function available(name: CapabilityName): CapabilityAssessment {
  return { capability: { name, available: true }, causes: [] };
}

function unavailable(
  name: CapabilityName,
  reason: string,
  causes: FindingCode[],
): CapabilityAssessment {
  return { capability: { name, available: false, reason }, causes };
}

function unavailableCapabilities(
  reason: string,
  causes: FindingCode[],
): CapabilityAssessment[] {
  return CAPABILITY_NAMES.map((name) => unavailable(name, reason, causes));
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The declared status code, whatever it says; `null` when there is no string there. */
function statusCodeOf(value: unknown): string | null {
  return isRecord(value) ? nonEmptyString(readProperty(value, "code")) : null;
}

/** Deterministic parse — no clock is read; an unparseable value yields `null`. */
function parseTime(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

const SAMPLE_LIMIT = 5;

function sample(values: readonly string[]): string {
  return sampleOf(values.slice(0, SAMPLE_LIMIT), values.length);
}

/**
 * The same rendering from a sample that was bounded as it was COLLECTED, plus
 * the total it was drawn from — for the counts too large to hold one entry per
 * occurrence, where the sample is all that was ever kept.
 */
function sampleOf(shown: readonly string[], total: number): string {
  if (total <= shown.length) return shown.join(", ");
  return `${shown.join(", ")} and ${total - shown.length} more`;
}

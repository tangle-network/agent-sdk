/**
 * Content-key alias vocabulary — the single source of truth for "where does a
 * trace producer put the human-readable CONTENT of a turn": the task, the
 * prompt, the model completion, and a tool call's name / args / result.
 *
 * This is the content sibling of {@link ./genai-attributes.ts} (model / token /
 * cost vocabulary) and follows the identical pattern: writers emit a producer's
 * own keys; the ingest READER accepts a wider candidate list per normalized
 * field because every coding agent and SDK spells the same field differently
 * (OTel GenAI, OpenInference, our own `tangle.*`, Claude Code's `claude_code.*`,
 * Codex's `codex.*`, OpenCode's `message.*` / `tool.*`). Co-locating the per-field
 * candidate lists and the resolver here is the drift guard: a producer's emitted
 * key and the reader's candidate list can never silently disagree, and adding an
 * agent is a DATA change (one alias row) rather than a code change in every
 * reader.
 *
 * Both consumers — the Intelligence ingest (span + log-record content recovery,
 * onboarding content check) and the standalone OpenCode exporter (which WRITES
 * under these keys) — import this layer, so "the producer shipped content" and
 * "the product can read it" mean the same thing by construction.
 *
 * Coding agents frequently carry this content on OTLP LOG events rather than
 * spans; {@link logRecordContentBag} is the one place that decides how a log row
 * becomes a bag the resolver can read.
 *
 * Fail-loud: a key whose value isn't a usable non-empty string (or, for
 * `messages`, a parseable array) is NOT recorded — {@link extractContent}
 * returns only the fields it actually found, never a fabricated default. An
 * empty bag returns an empty object, never sentinels.
 */

/** The normalized content a single attribute bag can carry. Every field is
 *  optional: a bag carries only the slices the emitter put on it. */
export interface NormalizedContent {
  task?: string;
  prompt?: string;
  completion?: string;
  toolName?: string;
  toolArgs?: string;
  toolResult?: string;
  messages?: unknown[];
}

/** The normalized field a content key maps to. `messages` is parsed as an
 *  array (or a JSON string that decodes to one); every other field is a
 *  non-empty string. */
export type ContentField = keyof NormalizedContent;

// ── Writer PRIMARY keys (the key a producer emits per field) ──────────────
// Named constants so a writer (e.g. the OpenCode exporter) emits under the
// canonical alias rather than a magic string, and the writer/reader can never
// drift on the spelling. Each is the canonical WRITE key for its field — the
// alias a Tangle producer emits under. It is NOT necessarily the first entry in
// that field's reader priority list (FIELD_KEY_PRIORITY may rank a `tangle.*` /
// `gen_ai.*` alias ahead of it when a richer source is also present); the writer
// key and a reader's top candidate are independent by design.

/** Prompt / user message — the writer key OpenCode's user-turn export uses. */
export const CONTENT_PROMPT_KEY = "gen_ai.prompt";
/** Model completion — the writer key OpenCode's assistant-text export uses. */
export const CONTENT_COMPLETION_KEY = "message.part.text";
/** Invoked tool's name. */
export const CONTENT_TOOL_NAME_KEY = "tool.name";
/** Tool call arguments. */
export const CONTENT_TOOL_ARGS_KEY = "tool.input";
/** Tool call output / result. */
export const CONTENT_TOOL_RESULT_KEY = "tool.output";

/**
 * The single alias table: content key → normalized field. Ordered by emitter
 * for auditability; resolution order within a field is "first matching key in
 * priority order wins" (see {@link FIELD_KEY_PRIORITY}), NOT table order.
 *
 * Coverage:
 *   - Standard OTel GenAI / OpenInference / our own `tangle.*` conventions.
 *   - Claude Code: the `claude_code.*` event attributes.
 *   - Codex: the `codex.*` event attributes (inner prompt key `prompt`,
 *     verified from codex-rs/otel; looser shim spellings folded in as
 *     low-priority fallbacks).
 *   - OpenCode: the `message.*` / `tool.*` event attributes.
 *
 * Adding an agent = add its rows here. No reader changes.
 */
const CONTENT_KEY_ALIASES: Readonly<Record<string, ContentField>> = {
  // ── Standard conventions (OTel GenAI, OpenInference, our own) ──────────
  "gen_ai.prompt": "prompt",
  "gen_ai.request.prompt": "prompt",
  "gen_ai.completion": "completion",
  "gen_ai.response.completion": "completion",
  "input.value": "prompt",
  "output.value": "completion",
  "llm.input_messages": "messages",
  "llm.output_messages": "messages",
  "user.message": "prompt",
  prompt: "prompt",
  "tangle.task": "task",
  "tangle.declared_intent": "task",
  "tangle.tool.args": "toolArgs",
  "tangle.tool.result": "toolResult",
  "tangle.tool.name": "toolName",
  "tool.name": "toolName",
  "tool.args": "toolArgs",

  // ── Claude Code (claude_code.* OTLP log events) ───────────────────────
  // claude_code.user_prompt event carries the user's prompt under 'prompt'.
  "claude_code.user_prompt.prompt": "prompt",
  // Bare 'prompt' on a claude_code.user_prompt record is covered by the
  // standard `prompt` row above; the dotted form is the same content when the
  // emitter namespaces the attribute under the event name.
  // claude_code.tool_result attrs: the input that was passed to the tool and
  // the tool's output.
  "claude_code.tool_result.tool_input": "toolArgs",
  "claude_code.tool_result.tool_parameters": "toolArgs",
  "claude_code.tool_result.tool_output": "toolResult",
  // claude_code.tool event: the tool's output.
  "claude_code.tool.tool.output": "toolResult",
  "claude_code.tool.output": "toolResult",
  // claude_code.api_request_body / api_response_body carry the FULL prompt +
  // completion JSON under 'body' — the richest content source. Routed to
  // `messages` and parsed (a JSON object/array body decodes to a messages
  // array or a single-element wrap).
  "claude_code.api_request_body.body": "messages",
  "claude_code.api_response_body.body": "messages",

  // ── Codex (codex.* OTLP log events) ───────────────────────────────────
  // codex.user_prompt event: the prompt text rides under the inner `prompt`
  // attribute. Verified prompt (codex-rs codex-rs/otel/src/events/session_telemetry.rs):
  // `log_event!(event.name = "codex.user_prompt", prompt_length = …, prompt = %prompt_to_log)`.
  // The namespaced dotted form mirrors claude_code.user_prompt.prompt.
  "codex.user_prompt.prompt": "prompt",
  // Looser shim spellings for emitters that rename the inner attribute away from
  // the upstream `prompt` macro. They are ranked below the verified
  // `codex.user_prompt.prompt` in FIELD_KEY_PRIORITY, so merge order here is
  // behaviorally irrelevant; a form that never matches is a no-op, never a
  // fabricated read.
  "codex.user_prompt.text": "prompt",
  "codex.user_prompt.message": "prompt",
  "codex.user_prompt.input": "prompt",
  "codex.tool_result.output": "toolResult",
  "codex.tool_result.result": "toolResult",

  // ── OpenCode (message.* / tool.* OTLP log events) ─────────────────────
  // The OpenCode exporter routes a USER-turn part to a prompt-aliased key
  // (gen_ai.prompt / user.message, above) and an ASSISTANT-turn part to
  // message.part.text → completion. message.text mirrors message.part.text for
  // emitters that flatten the part.
  "message.part.text": "completion",
  "message.text": "completion",
  "tool.input": "toolArgs",
  "tool.output": "toolResult",
};

/**
 * Reader candidate keys per normalized field, highest-confidence first.
 * When several aliased keys for the same field are present on one bag, the
 * first key in this list that is present wins — so `tangle.task` beats a bare
 * `prompt` for `task`, and the richest source (a full `messages` body) is
 * preferred where it exists. A key not listed here for its field still
 * resolves (it is appended after the explicit order), so adding an alias row
 * without touching this list is safe — it just lands at lowest priority.
 *
 * The `user_request` / `task` / `input` span-only prompt spellings the
 * intent-audit span path historically read are folded in here so the span and
 * log recovery paths resolve intent through ONE vocabulary.
 */
const FIELD_KEY_PRIORITY: Readonly<Record<ContentField, readonly string[]>> = {
  task: ["tangle.task", "tangle.declared_intent", "task"],
  prompt: [
    "gen_ai.prompt",
    "gen_ai.request.prompt",
    "claude_code.user_prompt.prompt",
    "codex.user_prompt.prompt",
    "codex.user_prompt.text",
    "codex.user_prompt.message",
    "codex.user_prompt.input",
    "input.value",
    "user.message",
    "user_request",
    "llm.input",
    "input",
    "prompt",
  ],
  completion: [
    "gen_ai.completion",
    "gen_ai.response.completion",
    "output.value",
    "message.part.text",
    "message.text",
  ],
  toolName: ["tangle.tool.name", "tool.name"],
  toolArgs: [
    "tangle.tool.args",
    "claude_code.tool_result.tool_input",
    "claude_code.tool_result.tool_parameters",
    "tool.input",
    "tool.args",
  ],
  toolResult: [
    "tangle.tool.result",
    "claude_code.tool_result.tool_output",
    "claude_code.tool.tool.output",
    "claude_code.tool.output",
    "codex.tool_result.output",
    "codex.tool_result.result",
    "tool.output",
  ],
  messages: [
    "claude_code.api_request_body.body",
    "claude_code.api_response_body.body",
    "llm.input_messages",
    "llm.output_messages",
  ],
};

/**
 * Every content key the alias layer knows about. Callers use this to detect
 * "is there any content on this bag at all" without re-deriving the set.
 * Frozen so a caller can't mutate the shared table. Excludes the span-only
 * prompt spellings, which are intent-recovery candidates rather than
 * content-presence signals.
 */
export const CONTENT_KEYS: readonly string[] = Object.freeze(
  Object.keys(CONTENT_KEY_ALIASES),
);

/** Map of every known content key → its normalized field, exposed read-only
 *  for callers that want to inspect or extend the mapping (e.g. enrichment
 *  joins that need to know which field a matched key feeds). */
export const CONTENT_KEY_FIELD: Readonly<Record<string, ContentField>> =
  Object.freeze({ ...CONTENT_KEY_ALIASES });

/** A non-empty trimmed string, or null. Absent/blank/non-string values are an
 *  honest miss, never "". */
export function asContentField(value: unknown): string | null {
  if (typeof value === "string") {
    const t = value.trim();
    return t.length > 0 ? t : null;
  }
  return null;
}

/** Flatten a tool-args / tool-result value to a string. Strings pass through;
 *  objects/arrays are JSON-stringified so a structured tool payload is still
 *  readable content. Null/empty → null (never "" or "null"). */
export function asContentString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = asContentField(value);
  if (s !== null) return s;
  if (typeof value === "object") {
    try {
      const json = JSON.stringify(value);
      return json && json !== "{}" && json !== "[]" ? json : null;
    } catch {
      return null;
    }
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

/**
 * Coerce a `messages`-aliased value into an array. Accepts an already-decoded
 * array, a JSON string that parses to an array, or a JSON object (a
 * Claude/Codex api_request_body whose top level is `{ messages: [...] }` or a
 * single message object). Returns null when nothing array-shaped is
 * recoverable — never a fabricated `[]`.
 */
function asMessages(value: unknown): unknown[] | null {
  let v = value;
  if (typeof v === "string") {
    const t = v.trim();
    if (t.length === 0) return null;
    try {
      v = JSON.parse(t);
    } catch {
      return null;
    }
  }
  if (Array.isArray(v)) return v.length > 0 ? v : null;
  if (v && typeof v === "object") {
    const inner = (v as Record<string, unknown>).messages;
    if (Array.isArray(inner)) return inner.length > 0 ? inner : null;
    // A single message object (api_request_body bodies sometimes wrap one turn)
    // — wrap it ONLY when it actually carries readable message text. An empty or
    // arbitrary object ({} or { foo: "bar" }) is NOT content; wrapping it would
    // make hasContent return a false positive on a metadata-only body.
    if (messageHasText(v as Record<string, unknown>)) return [v];
    return null;
  }
  return null;
}

/**
 * Recover the human-readable text from a single message-shaped object. The one
 * reader every message-text caller goes through, in priority order:
 *   1. `content` as a plain string;
 *   2. `content` as a LIST OF BLOCKS — the Anthropic / Claude Code message shape
 *      (`content: [{ type: "text", text }, { type: "tool_use", … }]`): the text
 *      of every text-bearing block is concatenated (newline-joined), tool/other
 *      blocks contribute nothing. Without this branch a Claude Code message
 *      whose content is an array is silently invisible to content recovery;
 *   3. a top-level `text` string;
 *   4. a nested `content.text` string (object-wrapped content).
 * Returns the first non-empty result, or null when no usable text exists — a
 * bare/arbitrary object yields null and is not treated as a usable message.
 */
function readMessageText(msg: Record<string, unknown>): string | null {
  const direct = asContentField(msg.content);
  if (direct !== null) return direct;

  const blocks = msg.content;
  if (Array.isArray(blocks)) {
    const parts: string[] = [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const text = asContentField((block as Record<string, unknown>).text);
      if (text !== null) parts.push(text);
    }
    if (parts.length > 0) return parts.join("\n");
  }

  const top = asContentField(msg.text);
  if (top !== null) return top;

  return asContentField((msg.content as Record<string, unknown> | null)?.text);
}

/** True when a single message-shaped object carries recoverable text. A
 *  bare/arbitrary object has none, so it is not treated as a usable message. */
function messageHasText(msg: Record<string, unknown>): boolean {
  return readMessageText(msg) !== null;
}

/**
 * Precomputed resolution order per field: the explicit priority list, then any
 * remaining aliased keys for that field appended at lowest priority. Built once
 * at module load (frozen) so the content-presence hot path (onboarding scans
 * every row) never re-runs an `Object.keys().filter()` over the alias table per
 * row — it reads a fixed array instead.
 */
const FIELD_KEY_ORDER: Readonly<Record<ContentField, readonly string[]>> =
  Object.freeze(
    Object.fromEntries(
      (Object.keys(FIELD_KEY_PRIORITY) as ContentField[]).map((field) => {
        const priority = FIELD_KEY_PRIORITY[field];
        const extras = Object.keys(CONTENT_KEY_ALIASES).filter(
          (k) => CONTENT_KEY_ALIASES[k] === field && !priority.includes(k),
        );
        return [field, Object.freeze([...priority, ...extras])];
      }),
    ) as Record<ContentField, readonly string[]>,
  );

/** The resolution order for one field: explicit priority list, then any
 *  remaining aliased keys for that field appended at lowest priority. */
function fieldKeyOrder(field: ContentField): readonly string[] {
  return FIELD_KEY_ORDER[field];
}

/** Resolve one normalized field from a bag: walk its priority list, then any
 *  remaining aliased keys for that field, returning the first usable value. */
function resolveField(
  bag: Record<string, unknown>,
  field: ContentField,
): NormalizedContent[ContentField] {
  for (const key of fieldKeyOrder(field)) {
    if (!(key in bag)) continue;
    const raw = bag[key];
    if (field === "messages") {
      const msgs = asMessages(raw);
      if (msgs) return msgs;
      continue;
    }
    if (field === "toolArgs" || field === "toolResult") {
      const s = asContentString(raw);
      if (s) return s;
      continue;
    }
    const s = asContentField(raw);
    if (s) return s;
  }
  return undefined;
}

const ALL_FIELDS: readonly ContentField[] = [
  "task",
  "prompt",
  "completion",
  "toolName",
  "toolArgs",
  "toolResult",
  "messages",
];

/**
 * Extract normalized content from a flattened attribute bag (span attributes
 * OR a log record's merged attribute bag). Pure: same input → same output, no
 * I/O, no env reads. Returns only the fields actually present; an empty/absent
 * bag returns `{}`.
 */
export function extractContent(
  attributes: Record<string, unknown> | undefined | null,
): NormalizedContent {
  const out: NormalizedContent = {};
  if (!attributes) return out;
  for (const field of ALL_FIELDS) {
    const v = resolveField(attributes, field);
    if (v !== undefined) {
      // Index assignment is safe: `field` is the matching key of the union.
      (out as Record<ContentField, unknown>)[field] = v;
    }
  }
  return out;
}

/**
 * The keys whose presence (with a usable value) counts as "this bag carries
 * content". The alias-table keys only — the span-only prompt spellings are
 * deliberately excluded so a metadata row that happens to carry a bare `input`
 * is not mislabelled content-bearing.
 */
const PRESENCE_KEYS: readonly string[] = Object.keys(CONTENT_KEY_ALIASES);

/** True when the bag carries ANY known content key with a usable value. A cheap
 *  presence check that SHORT-CIRCUITS on the first usable key — it does not
 *  build the NormalizedContent object or JSON-parse `messages` bodies, so a hot
 *  scan path (onboarding) pays per-row only until the first hit. */
export function hasContent(
  attributes: Record<string, unknown> | undefined | null,
): boolean {
  if (!attributes) return false;
  for (const key of PRESENCE_KEYS) {
    if (!(key in attributes)) continue;
    const field = CONTENT_KEY_ALIASES[key];
    const raw = attributes[key];
    if (field === "messages") {
      if (asMessages(raw)) return true;
      continue;
    }
    if (field === "toolArgs" || field === "toolResult") {
      if (asContentString(raw)) return true;
      continue;
    }
    if (asContentField(raw)) return true;
  }
  return false;
}

/**
 * Build the content-detection bag for a single OTLP log record. A log carries
 * its content either as flattened attributes (keyed by a content key) OR as the
 * record `body` for a prompt event whose text has no attribute key (a
 * `*.user_prompt` event whose prompt IS the body). This is the ONE place that
 * decides "how a log row becomes a bag `extractContent` can read", so the
 * intent-audit recovery, the trace-analyst log enrichment, and the onboarding
 * content check can never drift on it.
 *
 * The body is surfaced under the standard `prompt` alias ONLY for `*.user_prompt`
 * events (a generic log body is not content); an attribute-carried `prompt`
 * already present is never overwritten.
 */
export function logRecordContentBag(
  attributes: Record<string, unknown> | null | undefined,
  body: string | null | undefined,
): Record<string, unknown> {
  const bag: Record<string, unknown> = { ...(attributes ?? {}) };
  if (typeof body === "string" && body.trim().length > 0) {
    const eventName = asContentField(bag["event.name"]);
    if (
      eventName &&
      /(?:^|\.)user_prompt$/.test(eventName) &&
      !("prompt" in bag)
    ) {
      bag.prompt = body;
    }
  }
  return bag;
}

/** Known coding-agent service names, mapped to their canonical agent id. An
 *  EXACT match only — a substring guess ('claude-helper-bot') would mislabel a
 *  customer service into a coding-agent bucket and drive a wrong "you missed
 *  THIS gate" onboarding hint. The namespaced-key / gen_ai.system paths above
 *  this remain the reliable identity; this allowlist is the last resort for a
 *  content-less metadata row carrying only service.name. */
const KNOWN_AGENT_SERVICE_NAMES: Readonly<Record<string, string>> = {
  "claude-code": "claude-code",
  "claude code": "claude-code",
  claudecode: "claude-code",
  codex: "codex",
  "codex-cli": "codex",
  opencode: "opencode",
};

/**
 * Deterministic coding-agent label for an attribute bag, by the namespace of
 * the content/event keys it carries, then the standard `gen_ai.system` /
 * `service.name` identity. Returns a stable lowercase id
 * (`claude-code` | `codex` | `opencode` | the gen_ai.system name) or
 * `"unknown"` when nothing reliably identifies the emitter — never a fabricated
 * default that pretends to know which agent produced the row.
 *
 * `service.name` is matched against a KNOWN-AGENT ALLOWLIST (exact), not a
 * substring guess, so an arbitrary customer service named e.g. `claude-helper`
 * stays `unknown` rather than being mislabelled `claude-code` and driving a
 * wrong onboarding hint.
 */
export function classifyAgent(
  bag: Record<string, unknown> | null | undefined,
): string {
  if (!bag) return "unknown";
  const keys = Object.keys(bag);
  if (keys.some((k) => k.startsWith("claude_code."))) return "claude-code";
  if (keys.some((k) => k.startsWith("codex."))) return "codex";
  const eventName = asContentField(bag["event.name"]);
  if (eventName?.startsWith("claude_code.")) return "claude-code";
  if (eventName?.startsWith("codex.")) return "codex";
  // gen_ai.system is a producer-declared identity (the OpenCode exporter stamps
  // "opencode"); trust it as the emitter's own claim.
  const system = asContentField(bag["gen_ai.system"]);
  if (system) return system.toLowerCase();
  // OpenCode emits message.*/tool.* events with no agent-namespaced prefix; the
  // message.* key shape is the reliable tell before the lossy service.name.
  if (keys.some((k) => k.startsWith("message."))) return "opencode";
  const service = asContentField(bag["service.name"]);
  if (service) {
    const mapped = KNOWN_AGENT_SERVICE_NAMES[service.toLowerCase()];
    if (mapped) return mapped;
  }
  return "unknown";
}

/** A declared-intent recovery from a bag: the recovered text plus the source
 *  it came from — either the exact attribute key that matched, or `"messages"`
 *  when it came from the first user message of a parsed messages array. Lets a
 *  caller record traceable evidence (which key carried the intent) while still
 *  resolving through the ONE shared vocabulary. */
export interface DeclaredIntentMatch {
  text: string;
  /** The matched attribute key, or `"messages"` for a messages-array source. */
  source: string;
}

/**
 * Recover the declared intent from a flattened attribute bag through the shared
 * task/prompt/messages vocabulary, reporting WHICH key matched. The span path
 * and the log-record path both call this, so they resolve intent through one
 * key source and a key added to the shared layer is read by both. Walks the
 * `task` field's keys, then the `prompt` field's keys (which include the
 * span-only `user_request` / `input` / `llm.input` spellings folded into the
 * priority list), then the first user message of a messages body. Returns null
 * when nothing usable is present — never a fabricated intent.
 */
export function resolveDeclaredIntent(
  bag: Record<string, unknown> | null | undefined,
): DeclaredIntentMatch | null {
  if (!bag) return null;
  for (const field of ["task", "prompt"] as const) {
    for (const key of fieldKeyOrder(field)) {
      if (!(key in bag)) continue;
      const text = asContentField(bag[key]);
      if (text) return { text, source: key };
    }
  }
  for (const key of fieldKeyOrder("messages")) {
    if (!(key in bag)) continue;
    const msgs = asMessages(bag[key]);
    if (!msgs) continue;
    const text = declaredTaskText({ messages: msgs });
    if (text) return { text, source: "messages" };
  }
  return null;
}

/**
 * Best-effort declared-task text from normalized content, in the order a
 * declared intent is most likely to live: an explicit task, then the prompt,
 * then the first user message in a messages array. Deliberately does NOT
 * consult `completion` — an assistant completion is the agent's OUTPUT, not the
 * declared task; treating it as the task would fabricate intent. Returns null
 * when no genuine declared-task source is present — the caller skips, never
 * fabricates.
 */
export function declaredTaskText(content: NormalizedContent): string | null {
  if (content.task) return content.task;
  if (content.prompt) return content.prompt;
  if (content.messages) {
    for (const m of content.messages) {
      if (!m || typeof m !== "object") continue;
      const msg = m as Record<string, unknown>;
      const role = asContentField(msg.role);
      if (role && role !== "user") continue;
      const text = readMessageText(msg);
      if (text) return text;
    }
  }
  return null;
}

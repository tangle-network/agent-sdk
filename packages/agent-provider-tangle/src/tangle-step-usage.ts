import type { TokenUsage } from "@tangle-network/agent-interface";
import type { AgentEnvironmentEvent } from "@tangle-network/agent-interface/environment-provider";

type EventRecord = Record<string, unknown>;

/**
 * Attaches an execution's running usage to the step frames of its stream.
 *
 * Sandbox reports an execution's usage on its terminal `result` and `done`
 * frames. Before those frames, the only usage on the stream is the OpenCode
 * harness's own `step_finish` event, which the sidecar forwards as a `raw`
 * frame with that step's token counts. No other harness the sidecar runs
 * forwards usage before the terminal frames, so their streams stay unchanged.
 */
export interface StepUsageFold {
  /**
   * The event, carrying the execution's cumulative usage when it reports a
   * step not yet counted. Every other event is returned unchanged.
   */
  observe(event: AgentEnvironmentEvent): AgentEnvironmentEvent;
}

/**
 * Create the fold for one stream that starts at its execution's first frame.
 *
 * A cumulative total counts every step before it, so a stream that resumes
 * after a cursor, or joins at a live tail, must not use this fold.
 *
 * The terminal receipt stays authoritative. Its usage is never replaced, and
 * the step frames are never rewritten to agree with it. A receipt below the
 * streamed total is therefore delivered as reported, and a consumer that folds
 * cumulative usage sees the total fall instead of a silently lowered total.
 */
export function createStepUsageFold(): StepUsageFold {
  let total: TokenUsage | undefined;
  // A step whose counts are incomplete leaves every later total unknown.
  let established = true;
  const counted = new Set<string>();
  return {
    observe(event) {
      if (event.usage !== undefined || event.usageMode !== undefined) {
        return event;
      }
      const step = openCodeStepUsage(event);
      if (step === undefined || !established) return event;
      if (step.usage === undefined) {
        established = false;
        return event;
      }
      // The live stream and a reconnect replay can deliver one step twice.
      if (step.id !== undefined) {
        if (counted.has(step.id)) return event;
        counted.add(step.id);
      }
      total = total === undefined ? step.usage : addUsage(total, step.usage);
      return { ...event, usage: { ...total }, usageMode: "cumulative" };
    },
  };
}

/**
 * The step an OpenCode `step_finish` frame reports, in either wire shape.
 *
 * The sidecar (agent-dev-container `packages/sdk-provider-opencode/src/cli-events.ts`)
 * wraps the harness event as `{ type: "raw", backend: "opencode", event }`.
 * The live run stream writes only `event` as the frame data; the execution
 * replay writes the whole buffered envelope. Both frames carry one event id.
 *
 * `usage` is absent when the step reported counts without both totals.
 */
function openCodeStepUsage(
  event: AgentEnvironmentEvent,
): { id?: string; usage?: TokenUsage } | undefined {
  if (event.type !== "raw") return undefined;
  const envelope = event.data;
  const harnessEvent =
    envelope.type === "raw"
      ? envelope.backend === "opencode"
        ? plainRecord(envelope.event)
        : undefined
      : envelope;
  if (harnessEvent?.type !== "step_finish") return undefined;
  const part = plainRecord(harnessEvent.part);
  if (part?.type !== "step-finish" || part.tokens === undefined) {
    return undefined;
  }
  const id =
    typeof part.id === "string" && part.id.length > 0 ? part.id : event.id;
  return {
    ...(id === undefined ? {} : { id }),
    ...optionalUsage(stepTokenUsage(part.tokens)),
  };
}

/**
 * One step's counts in the terminal receipt's convention.
 *
 * OpenCode reports cache and reasoning tokens beside `input` and `output`.
 * The sidecar's receipt includes them in its totals (`recordStepUsage`), so
 * the step's input total adds both cache counts and its output total adds
 * reasoning. The class counts keep their own fields.
 */
function stepTokenUsage(value: unknown): TokenUsage | undefined {
  const tokens = plainRecord(value);
  if (tokens === undefined) {
    throw new Error("Tangle OpenCode step token counts must be an object");
  }
  const cache = tokens.cache === undefined ? {} : plainRecord(tokens.cache);
  if (cache === undefined) {
    throw new Error("Tangle OpenCode step cache counts must be an object");
  }
  const input = stepCount(tokens.input, "input");
  const output = stepCount(tokens.output, "output");
  const reasoning = stepCount(tokens.reasoning, "reasoning");
  const total = stepCount(tokens.total, "total");
  const cacheRead = stepCount(cache.read, "cache read");
  const cacheWrite = stepCount(cache.write, "cache write");
  if (input === undefined || output === undefined) return undefined;
  return {
    inputTokens: safeSum(input, cacheRead ?? 0, cacheWrite ?? 0),
    outputTokens: safeSum(output, reasoning ?? 0),
    ...(total === undefined ? {} : { totalTokens: total }),
    ...(cacheRead === undefined ? {} : { cacheReadInputTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheCreationInputTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  };
}

function stepCount(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Tangle OpenCode step ${label} token count is invalid`);
  }
  return value;
}

/** A count reported by either side is kept; one reported by neither stays absent. */
function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  const optional = (key: Exclude<keyof TokenUsage, "inputTokens" | "outputTokens" | "cost">) =>
    left[key] === undefined && right[key] === undefined
      ? {}
      : { [key]: safeSum(left[key] ?? 0, right[key] ?? 0) };
  return {
    inputTokens: safeSum(left.inputTokens, right.inputTokens),
    outputTokens: safeSum(left.outputTokens, right.outputTokens),
    ...optional("totalTokens"),
    ...optional("cacheReadInputTokens"),
    ...optional("cacheCreationInputTokens"),
    ...optional("reasoningTokens"),
  };
}

function safeSum(...values: number[]): number {
  const sum = values.reduce((left, right) => left + right, 0);
  if (!Number.isSafeInteger(sum)) {
    throw new Error("Tangle OpenCode step token total exceeded the safe integer range");
  }
  return sum;
}

function optionalUsage(usage: TokenUsage | undefined): { usage?: TokenUsage } {
  return usage === undefined ? {} : { usage };
}

function plainRecord(value: unknown): EventRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as EventRecord)
    : undefined;
}

import { AgentTurnResultSchema } from "@tangle-network/agent-interface/environment-provider";
import type {
  AgentEnvironment,
  AgentEnvironmentEvent,
  AgentTurnInput,
} from "@tangle-network/agent-interface/environment-provider";
import { isTerminalEvent } from "../conformance-helpers.js";

const eventSchema = AgentTurnResultSchema.shape.events.unwrap().element;

export interface TimedEvent {
  event: AgentEnvironmentEvent;
  /** Milliseconds since the turn started when this event was yielded. */
  atMs: number;
}

export interface TurnObservation {
  events: TimedEvent[];
  terminals: AgentEnvironmentEvent[];
  /** The thrown error when the stream rejected, otherwise undefined. */
  error?: unknown;
  durationMs: number;
}

/** Run one turn to its end, recording when each event arrived. A rejection is returned, not thrown. */
export async function observeTurn(environment: AgentEnvironment, input: AgentTurnInput): Promise<TurnObservation> {
  const started = Date.now();
  const events: TimedEvent[] = [];
  let error: unknown;
  try {
    for await (const event of environment.stream(input)) events.push({ event, atMs: Date.now() - started });
  } catch (caught) {
    error = caught;
  }
  return {
    events,
    terminals: events.map((entry) => entry.event).filter(isTerminalEvent),
    ...(error === undefined ? {} : { error }),
    durationMs: Date.now() - started,
  };
}

export function terminalStatus(event: AgentEnvironmentEvent | undefined): string | undefined {
  if (event === undefined) return undefined;
  const status = event.data.status;
  if (typeof status === "string") return status;
  return event.type.endsWith(".failed") || event.type === "error" ? "failed" : "completed";
}

/** The turn's verdict: failed when any terminal-class event says so, since a stream may repeat failure before it ends. */
export function turnOutcome(observation: TurnObservation): "completed" | "failed" | "none" {
  if (observation.terminals.length === 0) return "none";
  return observation.terminals.some((event) => terminalStatus(event) === "failed") ? "failed" : "completed";
}

/** The final assistant message: the terminal event's `finalText`, else the text parts the stream carried. */
export function finalText(observation: TurnObservation): string {
  for (const event of [...observation.terminals].reverse()) {
    const declared = event.data.finalText ?? event.data.text;
    if (typeof declared === "string" && declared.length > 0) return declared;
  }
  const parts = new Map<string, string>();
  for (const { event } of observation.events) {
    const normalized = event.normalized as { type?: string; part?: { type?: string; id?: string; text?: string } } | undefined;
    if (normalized?.type === "message.part.updated" && normalized.part?.type === "text" && typeof normalized.part.text === "string") {
      parts.set(normalized.part.id ?? String(parts.size), normalized.part.text);
    }
  }
  return [...parts.values()].join("");
}

export function eventSchemaIssues(observation: TurnObservation): string[] {
  const issues: string[] = [];
  observation.events.forEach(({ event }, index) => {
    const parsed = eventSchema.safeParse(event);
    if (!parsed.success) issues.push(`event ${index} (${event.type}): ${parsed.error.issues[0]?.message ?? "invalid"}`);
  });
  return issues;
}

/** The model the harness reported serving: `data.effectiveBackend.model`, from the first event or the terminal. */
export function servedModel(observation: TurnObservation): string | undefined {
  for (const { event } of [...observation.events].reverse()) {
    const backend = event.data.effectiveBackend;
    if (backend !== null && typeof backend === "object" && typeof (backend as { model?: unknown }).model === "string") {
      return (backend as { model: string }).model;
    }
  }
  return undefined;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}${(error as { code?: unknown }).code === undefined ? "" : `/${String((error as { code?: unknown }).code)}`}: ${error.message.slice(0, 240)}`;
  return String(error).slice(0, 240);
}

export const waitMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

import {
  InteractionKind,
  InteractionRequestSchema,
  type InteractionAcknowledgement,
  type InteractionRequest,
} from "@tangle-network/agent-interface";
import type { AgentEnvironmentEvent } from "@tangle-network/agent-interface/environment-provider";

/** Run coordinates the stream that carried an ask was bound to. */
export interface ObservedRun {
  runId?: string;
  executionId?: string;
}

/**
 * An outstanding ask this environment observed on a session stream.
 *
 * `request` is present only when the ask arrived as an `interaction` event,
 * which is the sole source of a verifiable binding and answer spec. A plan
 * arrives as `plan.submitted` and carries neither, so `run` holds the exact
 * coordinates of the stream that carried it, and a plan response is checked
 * against those.
 */
export interface ObservedInteraction {
  kind: string;
  request?: InteractionRequest;
  run?: ObservedRun;
  cancelled: boolean;
}

/** The acknowledgement this adapter already produced for one interaction. */
export interface RecordedInteractionResolution {
  operationId: string;
  commandDigest: string;
  responseDigest: string;
  acknowledgement: InteractionAcknowledgement;
}

const MAX_TRACKED_ENVIRONMENTS = 256;
const MAX_TRACKED_SESSIONS = 256;
const MAX_TRACKED_INTERACTIONS_PER_SESSION = 1_024;

interface SessionInteractions {
  observed: Map<string, ObservedInteraction>;
  resolutions: Map<string, RecordedInteractionResolution>;
}

function evictOldest(map: Map<string, unknown>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

function eventPayload(event: AgentEnvironmentEvent): Record<string, unknown> {
  return event.data;
}

function nonEmptyId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    ? value
    : undefined;
}

function observedRun(run: ObservedRun | undefined): ObservedRun | undefined {
  const runId = nonEmptyId(run?.runId);
  const executionId = nonEmptyId(run?.executionId);
  if (runId === undefined && executionId === undefined) return undefined;
  return {
    ...(runId === undefined ? {} : { runId }),
    ...(executionId === undefined ? {} : { executionId }),
  };
}

/**
 * Per-environment record of the asks its sessions raised and the answers this
 * adapter already delivered.
 *
 * An ask is answerable only after it was observed: the canonical response
 * command names an interaction id but not its kind, and the kind selects the
 * Sandbox method that resolves it. An unobserved id is therefore reported as
 * `unknown_interaction` instead of guessed at.
 *
 * The maps are bounded and evict oldest-first. An evicted resolution costs this
 * adapter the local replay answer for that interaction: the retry then reaches
 * the Sandbox route, whose durable ledger the `interactions` claim requires, so
 * the agent still receives one answer — but this adapter can no longer prove
 * which side resolved the ask, and it reports the runtime's own verdict.
 */
export class TangleInteractionLedger {
  private readonly sessions = new Map<string, SessionInteractions>();

  /**
   * Record an ask, or its withdrawal, from one converted session event.
   *
   * `run` names the exact run the carrying stream is bound to. It is the only
   * run coordinate available for a `plan.submitted` ask, which carries no
   * binding of its own.
   */
  observe(
    sessionId: string,
    event: AgentEnvironmentEvent,
    run?: ObservedRun,
  ): void {
    if (event.type === "interaction") {
      const parsed = InteractionRequestSchema.safeParse(
        eventPayload(event).request,
      );
      // An ask this adapter cannot parse cannot be answered against its own
      // binding and answer spec, so it stays unobserved rather than half-known.
      if (!parsed.success) return;
      this.entry(sessionId).observed.set(parsed.data.id, {
        kind: parsed.data.kind,
        request: parsed.data,
        cancelled: false,
      });
      this.bound(sessionId);
      return;
    }
    if (event.type === "interaction.cancel") {
      const id = nonEmptyId(eventPayload(event).id);
      if (id === undefined) return;
      const observed = this.entry(sessionId).observed.get(id);
      if (observed === undefined) return;
      observed.cancelled = true;
      return;
    }
    if (event.type === "plan.submitted") {
      const plan = eventPayload(event).plan;
      if (!plan || typeof plan !== "object" || Array.isArray(plan)) return;
      const id = nonEmptyId((plan as { id?: unknown }).id);
      if (id === undefined) return;
      const carried = observedRun(run);
      this.entry(sessionId).observed.set(id, {
        kind: InteractionKind.Plan,
        ...(carried ? { run: carried } : {}),
        cancelled: false,
      });
      this.bound(sessionId);
    }
  }

  observed(
    sessionId: string,
    interactionId: string,
  ): ObservedInteraction | undefined {
    return this.sessions.get(sessionId)?.observed.get(interactionId);
  }

  /**
   * Ids of the asks of one kind this adapter observed on a session and has
   * neither resolved nor seen withdrawn.
   *
   * `SandboxSession.answer()` carries no interaction id, so the caller uses
   * this set to prove which ask an untargeted delivery lands on.
   */
  unresolved(sessionId: string, kind: string): string[] {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return [];
    const ids: string[] = [];
    for (const [id, observed] of entry.observed) {
      if (observed.kind !== kind) continue;
      if (observed.cancelled) continue;
      if (entry.resolutions.has(id)) continue;
      ids.push(id);
    }
    return ids;
  }

  resolution(
    sessionId: string,
    interactionId: string,
  ): RecordedInteractionResolution | undefined {
    return this.sessions.get(sessionId)?.resolutions.get(interactionId);
  }

  record(
    sessionId: string,
    interactionId: string,
    resolution: RecordedInteractionResolution,
  ): void {
    const entry = this.entry(sessionId);
    entry.resolutions.set(interactionId, resolution);
    evictOldest(entry.resolutions, MAX_TRACKED_INTERACTIONS_PER_SESSION);
  }

  private entry(sessionId: string): SessionInteractions {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created: SessionInteractions = {
      observed: new Map(),
      resolutions: new Map(),
    };
    this.sessions.set(sessionId, created);
    evictOldest(this.sessions, MAX_TRACKED_SESSIONS);
    return created;
  }

  private bound(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) evictOldest(entry.observed, MAX_TRACKED_INTERACTIONS_PER_SESSION);
  }
}

/**
 * One ledger per environment id, held by the provider that mints the
 * environments.
 *
 * `provider.get()` rebuilds the environment object for a sandbox that already
 * exists. The rebuilt object answers response commands the earlier object
 * delivered, so the resolution record must outlive the object: a per-object
 * ledger would report a second delivery as a fresh `accepted`.
 */
export class TangleInteractionLedgerRegistry {
  private readonly ledgers = new Map<string, TangleInteractionLedger>();

  ledgerFor(environmentId: string): TangleInteractionLedger {
    const existing = this.ledgers.get(environmentId);
    if (existing) return existing;
    const created = new TangleInteractionLedger();
    this.ledgers.set(environmentId, created);
    evictOldest(this.ledgers, MAX_TRACKED_ENVIRONMENTS);
    return created;
  }
}

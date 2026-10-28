/** Where one responder is in its answer. */
export type SpeakerState = "answering" | "done" | "failed";

/**
 * A responder of a turn addressed to several agents. In the turn's parts it is
 * a `{ type: "speaker", id, name, handle?, state? }` part written before the
 * responder's answer.
 */
export interface Speaker {
  /** The agent's stable id. It keys the avatar's tone and a live part's `speaker` tag. */
  id: string;
  name: string;
  /** What a person types after `@` to address the agent. */
  handle?: string;
  /** Set once the responder ended; absent while it answers and on rows written before responders reported an end. */
  state?: SpeakerState;
}

export type SpeakerPart = Speaker & { type: "speaker" };

/** One responder's share of a turn: its speaker part and the parts it wrote. */
export interface SpeakerSection<T> {
  /** The latest speaker part for this responder; null for the parts no speaker owns. */
  speaker: (T & SpeakerPart) | null;
  parts: T[];
}

function isSpeakerPart<T>(part: T): part is T & SpeakerPart {
  const record = part as { type?: unknown; id?: unknown; name?: unknown } | null;
  return !!record && record.type === "speaker" && typeof record.id === "string" && typeof record.name === "string";
}

/**
 * Splits one assistant turn's parts by the agent that wrote them.
 *
 * A stored row holds a speaker part before each responder's answer, so a part
 * belongs to the speaker part before it. A live stream announces every
 * responder first and then interleaves their output, so a part names its owner
 * in `speaker` (the responder's id), which wins over position. A later speaker
 * part with an id already seen replaces that responder's speaker part, which is
 * how its end state arrives, and never opens a second section.
 *
 * Sections keep the order speakers were first announced. Parts no speaker owns
 * come first, in a section whose `speaker` is null; a turn without speaker
 * parts is that one section. No part is dropped, copied or reordered within its
 * section.
 */
export function partitionBySpeaker<T extends object>(parts: readonly T[]): SpeakerSection<T>[] {
  const sections = new Map<string, SpeakerSection<T>>();
  const unowned: T[] = [];
  let current: SpeakerSection<T> | undefined;
  for (const part of parts) {
    if (isSpeakerPart(part)) {
      current = sections.get(part.id);
      if (current) current.speaker = part;
      else sections.set(part.id, (current = { speaker: part, parts: [] }));
      continue;
    }
    const tag = (part as { speaker?: unknown }).speaker;
    const owner = typeof tag === "string" ? sections.get(tag) : current;
    (owner?.parts ?? unowned).push(part);
  }
  const owned = [...sections.values()];
  return unowned.length > 0 || owned.length === 0 ? [{ speaker: null, parts: unowned }, ...owned] : owned;
}


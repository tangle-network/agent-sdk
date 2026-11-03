/**
 * Part-text suffix coding. A harness restates a text or reasoning part's whole
 * text on every `message.part.updated` frame, so an N-byte part costs O(N²)
 * bytes to store or send (a Discovery root stream: 209 KB per 106-byte line).
 * A `PartTextCoder` carries a frame whose text extends the part's last text in
 * its stream as the suffix alone. A client asking with `?partText=suffix` gets
 * frames marked `"partText": "suffix" | "full"`; `decodePartTextFrame` restores them.
 */

/** The query parameter that asks for suffixes, and the field a coded frame carries. */
export const PART_TEXT = "partText";
export const PART_TEXT_SUFFIX = "suffix";
export type PartTextMode = typeof PART_TEXT_SUFFIX | "full";
type Part = Record<string, unknown>;

const isObject = (value: unknown): value is Part =>
  typeof value === "object" && value !== null;

/** A frame's part, in either producer shape: `{ part }` or `{ properties: { part } }`. */
export function locatePart(data: unknown): Part | null {
  if (!isObject(data)) return null;
  const nested = isObject(data.properties) ? data.properties.part : undefined;
  if (isObject(nested)) return nested;
  return isObject(data.part) ? data.part : null;
}

/** A frame's text or reasoning part with a string id and text. */
export function growingTextPart(data: unknown): (Part & { id: string; text: string }) | null {
  const part = locatePart(data);
  if (part?.type !== "text" && part?.type !== "reasoning") return null;
  return typeof part.id === "string" && typeof part.text === "string"
    ? (part as Part & { id: string; text: string })
    : null;
}

/** What one stream has carried for each part. */
export class PartTextCoder {
  readonly #texts = new Map<string, string>();

  /** Records `text`; the suffix to carry when it extends the part's last text. */
  encode(id: string, text: string): string | undefined {
    const previous = this.#texts.get(id);
    this.#texts.set(id, text);
    return previous !== undefined && text.startsWith(previous) ? text.slice(previous.length) : undefined;
  }

  /** Records and returns the whole text a carried value stands for. */
  decode(id: string, mode: PartTextMode, carried: string): string {
    const text = mode === PART_TEXT_SUFFIX ? (this.#texts.get(id) ?? "") + carried : carried;
    this.#texts.set(id, text);
    return text;
  }

  text(id: string): string | undefined {
    return this.#texts.get(id);
  }
}

/** One outgoing frame's JSON data, suffix-coded and marked; other frames pass. */
export function encodePartTextFrame(coder: PartTextCoder, event: string | undefined, data: string): string {
  if (event !== "message.part.updated" && !data.includes("message.part.updated")) return data;
  let frame: Part;
  try {
    frame = JSON.parse(data) as Part;
  } catch {
    return data;
  }
  const part = growingTextPart(frame);
  if (!part) return data;
  const suffix = coder.encode(part.id, part.text);
  if (suffix !== undefined) part.text = suffix;
  frame[PART_TEXT] = suffix === undefined ? "full" : PART_TEXT_SUFFIX;
  return JSON.stringify(frame);
}

/** Restores a parsed frame `encodePartTextFrame` marked, in place; others pass. */
export function decodePartTextFrame(coder: PartTextCoder, frame: Part): void {
  const mode = frame[PART_TEXT];
  if (mode !== PART_TEXT_SUFFIX && mode !== "full") return;
  delete frame[PART_TEXT];
  const part = growingTextPart(frame);
  if (part) part.text = coder.decode(part.id, mode, part.text);
}

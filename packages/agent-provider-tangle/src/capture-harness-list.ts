/** Bound the wire document independently of this client's known vocabulary. */
const MAX_HARNESS_ENTRIES = 256;
const MAX_HARNESS_ID_LENGTH = 128;
const INVALID_ID_CHARACTER = /[\s\u0000-\u001f\u007f]/u;

/**
 * Validate the whole capability list, then project the IDs this client knows.
 * A newer server may advertise additional harnesses without breaking a known
 * selection. An unknown ID never grants support; selected-harness admission is
 * still required. Malformed, sparse, duplicate and unbounded lists fail closed.
 */
export function recognizedCaptureHarnesses<H extends string>(
  raw: unknown,
  knownHarnesses: readonly H[],
): readonly H[] {
  const fail = (): never => {
    throw new Error("Tangle deployment has not proven native session capture with a valid harness list");
  };
  if (!Array.isArray(raw) || raw.length > MAX_HARNESS_ENTRIES) return fail();
  const known = new Set<string>(knownHarnesses);
  const seen = new Set<string>();
  const recognized: H[] = [];
  for (const id of raw) {
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_HARNESS_ID_LENGTH ||
        INVALID_ID_CHARACTER.test(id) || seen.has(id)) return fail();
    seen.add(id);
    if (known.has(id)) recognized.push(id as H);
  }
  return Object.freeze(recognized);
}

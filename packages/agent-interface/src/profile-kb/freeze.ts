/**
 * Freeze a knowledge-base record and everything it holds. The exported records
 * are shared process-wide and back the lookup index, so a consumer that edits
 * one would silently change every later composition.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

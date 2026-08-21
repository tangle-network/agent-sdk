/**
 * Make a validated value immutable before it is handed out.
 *
 * A profile snapshot, a certified context, and a capability document are each
 * evidence: something already checked, that a caller then reads and acts on.
 * If the copy the caller holds can be written to, the evidence can be changed
 * after the check that made it trustworthy, and a mutated capability flag
 * describes a surface the environment does not have.
 *
 * Values already visited are skipped, so a value that refers back to itself is
 * frozen once instead of recursing until the stack runs out.
 */
export function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

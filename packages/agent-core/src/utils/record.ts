/** True for a non-null, non-array object, the shape parsed JSON objects take. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

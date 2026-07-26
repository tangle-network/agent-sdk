export function numbersApproximatelyEqual(left: number, right: number): boolean {
  const tolerance =
    Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)) * 16;
  return Math.abs(left - right) <= tolerance;
}

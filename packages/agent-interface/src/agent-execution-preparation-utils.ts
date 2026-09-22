import {
  canonicalCandidateJson,
  isWellFormedUnicode,
} from "./agent-candidate-schema-common.js";
import {
  AGENT_PROFILE_MATERIALIZATION_AXES,
  type AgentProfileMaterializationAxis,
} from "./agent-profile-materialization.js";
import { REASONING_EFFORTS, type ReasoningEffort } from "./agent-profile.js";
import type {
  AgentExecutionPreparationAxisResult,
  AgentExecutionPreparationResolvedModel,
  AgentExecutionPreparationValidationIssue,
} from "./agent-execution-preparation-types.js";

export function isCanonicalJsonPointer(value: string): boolean {
  if (!value.startsWith("/") || !isWellFormedUnicode(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "~") continue;
    const escape = value[index + 1];
    if (escape !== "0" && escape !== "1") return false;
    index += 1;
  }
  return true;
}

const AXIS_ORDER = new Map<string, number>(
  AGENT_PROFILE_MATERIALIZATION_AXES.map((axis, index) => [axis, index]),
);

export function compareAxisResults(
  left: AgentExecutionPreparationAxisResult,
  right: AgentExecutionPreparationAxisResult,
): number {
  const axisDifference =
    (AXIS_ORDER.get(left.axis) ?? Number.MAX_SAFE_INTEGER) -
    (AXIS_ORDER.get(right.axis) ?? Number.MAX_SAFE_INTEGER);
  if (axisDifference !== 0) return axisDifference;
  const leftPath = left.path ?? "";
  const rightPath = right.path ?? "";
  return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
}

export function axisResultKey(
  axis: AgentProfileMaterializationAxis,
  path: string | undefined,
): string {
  return `${axis}\u0000${path ?? ""}`;
}

export function canonicalValuesEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalCandidateJson(left) === canonicalCandidateJson(right);
  } catch {
    return Object.is(left, right);
  }
}

export function canonicalRowsEqual(
  left: AgentExecutionPreparationAxisResult,
  right: AgentExecutionPreparationAxisResult,
): boolean {
  try {
    return canonicalCandidateJson(left) === canonicalCandidateJson(right);
  } catch {
    return false;
  }
}

export function compareDigest(
  issues: AgentExecutionPreparationValidationIssue[],
  label: string,
  actual: string,
  expected: string,
): void {
  if (actual === expected) return;
  issues.push({
    code: "digest-mismatch",
    message: `${label} digest does not match the prepared execution`,
  });
}

export function compareExpectation<T>(
  issues: AgentExecutionPreparationValidationIssue[],
  label: string,
  actual: T,
  expected: T | undefined,
): void {
  if (expected === undefined || actual === expected) return;
  issues.push({
    code: "expectation-mismatch",
    message: `${label} does not match the prepared execution`,
  });
}

export function readJsonPointer(root: unknown, pointer: string): unknown {
  let value = root;
  for (const encoded of pointer.slice(1).split("/")) {
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (value === null || typeof value !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function cleanAxisResult(
  result: AgentExecutionPreparationAxisResult,
  path: string | undefined,
): AgentExecutionPreparationAxisResult {
  return {
    axis: result.axis,
    disposition: result.disposition,
    owner: result.owner,
    mechanism: result.mechanism,
    ...(result.evidenceDigest === undefined
      ? {}
      : { evidenceDigest: result.evidenceDigest }),
    ...(path === undefined ? {} : { path }),
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  };
}

export function cleanResolvedModel(
  model: AgentExecutionPreparationResolvedModel,
): AgentExecutionPreparationResolvedModel {
  return {
    requested: model.requested,
    resolved: model.resolved,
    ...(model.provider === undefined ? {} : { provider: model.provider }),
    ...(model.reasoningEffort === undefined
      ? {}
      : {
          reasoningEffort: {
            requested: model.reasoningEffort.requested,
            ...(model.reasoningEffort.resolved === undefined
              ? {}
              : { resolved: model.reasoningEffort.resolved }),
            fidelity: model.reasoningEffort.fidelity,
          },
        }),
  };
}

export function isDownwardReasoningClamp(
  requested: ReasoningEffort,
  resolved: ReasoningEffort,
): boolean {
  return REASONING_EFFORTS.indexOf(resolved) < REASONING_EFFORTS.indexOf(requested);
}

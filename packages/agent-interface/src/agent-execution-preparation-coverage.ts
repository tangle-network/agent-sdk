import type { AgentProfile } from "./agent-profile.js";
import {
  profileMaterializationRequests,
  type AgentProfileMaterializationAxis,
} from "./agent-profile-materialization.js";
import type {
  AgentExecutionPreparationAxisResult,
  AgentExecutionPreparationReceipt,
  AgentExecutionPreparationValidationIssue,
} from "./agent-execution-preparation-types.js";
import {
  axisResultKey,
  canonicalRowsEqual,
  canonicalValuesEqual,
  cleanAxisResult,
  compareAxisResults,
  readJsonPointer,
} from "./agent-execution-preparation-utils.js";

export function validateHarnessAndModel(
  receipt: AgentExecutionPreparationReceipt,
  authoredProfile: AgentProfile,
  effectiveProfile: AgentProfile,
  issues: AgentExecutionPreparationValidationIssue[],
): void {
  if (
    effectiveProfile.harness !== undefined &&
    effectiveProfile.harness !== receipt.harness
  ) {
    issues.push({
      code: "expectation-mismatch",
      message:
        `effective profile harness ${effectiveProfile.harness} does not match ` +
        `prepared harness ${receipt.harness}`,
      axis: "harness",
      path: "/harness",
    });
  }
  if (
    effectiveProfile.model?.default !== undefined &&
    effectiveProfile.model.default !== receipt.resolvedModel.requested
  ) {
    issues.push({
      code: "model-fidelity",
      message: "prepared model request does not match effective profile.model.default",
      axis: "modelDefault",
      path: "/model/default",
    });
  }
  if (
    effectiveProfile.model?.provider !== undefined &&
    effectiveProfile.model.provider !== receipt.resolvedModel.provider
  ) {
    issues.push({
      code: "model-fidelity",
      message: "prepared model provider does not match effective profile.model.provider",
      axis: "modelProvider",
      path: "/model/provider",
    });
  }

  const requestedEffort =
    effectiveProfile.model?.reasoningEffort ??
    authoredProfile.model?.reasoningEffort;
  if (requestedEffort === undefined) return;
  const effort = receipt.resolvedModel.reasoningEffort;
  if (effort === undefined) {
    issues.push({
      code: "model-fidelity",
      message: "requested reasoning effort is missing from the prepared model",
      axis: "modelReasoningEffort",
      path: "/model/reasoningEffort",
    });
    return;
  }
  if (effort.requested !== requestedEffort) {
    issues.push({
      code: "model-fidelity",
      message:
        `prepared reasoning request ${effort.requested} does not match ` +
        `profile request ${requestedEffort}`,
      axis: "modelReasoningEffort",
      path: "/model/reasoningEffort",
    });
  }
}

export function validateAxisCoverage(
  receipt: AgentExecutionPreparationReceipt,
  authoredProfile: AgentProfile,
  effectiveProfile: AgentProfile,
  issues: AgentExecutionPreparationValidationIssue[],
): void {
  const authored = requestMap(authoredProfile);
  const effective = requestMap(effectiveProfile);
  const expected = new Map([...authored, ...effective]);
  const expectedPathsByAxis = new Map<AgentProfileMaterializationAxis, string[]>();
  for (const request of expected.values()) {
    const paths = expectedPathsByAxis.get(request.axis) ?? [];
    paths.push(request.path);
    expectedPathsByAxis.set(request.axis, paths);
  }
  for (const paths of expectedPathsByAxis.values()) paths.sort();

  const actual = new Map<
    string,
    { result: AgentExecutionPreparationAxisResult; path: string }
  >();
  for (const result of receipt.axisResults) {
    const paths = expectedPathsByAxis.get(result.axis) ?? [];
    const path = result.path ?? (paths.length === 1 ? paths[0] : undefined);
    if (path === undefined) {
      issues.push({
        code: paths.length === 0 ? "unrequested-coverage" : "ambiguous-coverage",
        message:
          paths.length === 0
            ? `receipt covers unrequested ${result.axis} without an exact path`
            : `${result.axis} covers ${paths.length} requested paths and requires an exact path`,
        axis: result.axis,
      });
      continue;
    }
    const key = axisResultKey(result.axis, path);
    const previous = actual.get(key);
    if (previous !== undefined) {
      const duplicate = canonicalRowsEqual(
        { ...previous.result, path },
        { ...result, path },
      );
      issues.push({
        code: duplicate ? "duplicate-coverage" : "conflicting-coverage",
        message:
          duplicate
            ? `duplicate coverage for ${result.axis} at ${path}`
            : `conflicting coverage for ${result.axis} at ${path}`,
        axis: result.axis,
        path,
      });
      continue;
    }
    actual.set(key, { result, path });
    if (!expected.has(key)) {
      issues.push({
        code: "unrequested-coverage",
        message: `receipt covers unrequested ${result.axis} path ${path}`,
        axis: result.axis,
        path,
      });
    }
  }

  const allowPartial = authoredProfile.resources?.failOnError === false;
  for (const [key, request] of expected) {
    const coverage = actual.get(key);
    if (coverage === undefined) {
      issues.push({
        code: "missing-coverage",
        message: `receipt is missing ${request.axis} coverage at ${request.path}`,
        axis: request.axis,
        path: request.path,
      });
      continue;
    }
    const authoredRequest = authored.get(key);
    const effectiveRequest = effective.get(key);
    const changed =
      authoredRequest === undefined ||
      effectiveRequest === undefined ||
      !canonicalValuesEqual(authoredRequest.value, effectiveRequest.value);
    const executionOverride =
      request.axis === "modelReasoningEffort" &&
      receipt.resolvedModel.reasoningEffort?.fidelity === "clamped";

    if (
      changed &&
      coverage.result.disposition !== "overridden" &&
      coverage.result.disposition !== "unsupported"
    ) {
      issues.push({
        code: "invalid-disposition",
        message:
          `${request.axis} at ${request.path} changed between authored and ` +
          `effective profiles but is marked ${coverage.result.disposition}`,
        axis: request.axis,
        path: request.path,
      });
    }
    if (
      !changed &&
      !executionOverride &&
      coverage.result.disposition === "overridden"
    ) {
      issues.push({
        code: "invalid-disposition",
        message:
          `${request.axis} at ${request.path} is marked overridden without ` +
          "an effective change",
        axis: request.axis,
        path: request.path,
      });
    }
    if (coverage.result.disposition === "unsupported" && !allowPartial) {
      issues.push({
        code: "strict-unsupported",
        message:
          `${request.axis} at ${request.path} is unsupported but the authored ` +
          "profile did not explicitly set resources.failOnError=false",
        axis: request.axis,
        path: request.path,
      });
    }

    if (request.axis === "modelReasoningEffort") {
      const fidelity = receipt.resolvedModel.reasoningEffort?.fidelity;
      if (
        coverage.result.disposition === "unsupported" &&
        fidelity !== "unsupported"
      ) {
        issues.push({
          code: "model-fidelity",
          message: "unsupported reasoning coverage requires unsupported model fidelity",
          axis: request.axis,
          path: request.path,
        });
      }
      if (
        fidelity === "unsupported" &&
        coverage.result.disposition !== "unsupported"
      ) {
        issues.push({
          code: "model-fidelity",
          message: "unsupported reasoning fidelity must be reported as unsupported coverage",
          axis: request.axis,
          path: request.path,
        });
      }
      if (
        fidelity === "clamped" &&
        coverage.result.disposition !== "overridden"
      ) {
        issues.push({
          code: "model-fidelity",
          message: "clamped reasoning fidelity must be reported as overridden coverage",
          axis: request.axis,
          path: request.path,
        });
      }
    }
  }
}

interface RequestedPath {
  axis: AgentProfileMaterializationAxis;
  path: string;
  value: unknown;
}

function requestMap(profile: AgentProfile): Map<string, RequestedPath> {
  const requests = new Map<string, RequestedPath>();
  for (const request of profileMaterializationRequests(profile)) {
    requests.set(axisResultKey(request.axis, request.path), {
      ...request,
      value: readJsonPointer(profile, request.path),
    });
  }
  return requests;
}

export function normalizeAxisResults(
  results: readonly AgentExecutionPreparationAxisResult[],
  authoredProfile: AgentProfile,
  effectiveProfile: AgentProfile,
): AgentExecutionPreparationAxisResult[] {
  const expected = new Map([
    ...profileMaterializationRequests(authoredProfile).map((request) => [
      axisResultKey(request.axis, request.path),
      request,
    ] as const),
    ...profileMaterializationRequests(effectiveProfile).map((request) => [
      axisResultKey(request.axis, request.path),
      request,
    ] as const),
  ]);
  const pathsByAxis = new Map<AgentProfileMaterializationAxis, string[]>();
  for (const request of expected.values()) {
    const paths = pathsByAxis.get(request.axis) ?? [];
    paths.push(request.path);
    pathsByAxis.set(request.axis, paths);
  }
  return results
    .map((result) => {
      const possiblePaths = pathsByAxis.get(result.axis) ?? [];
      const path =
        result.path ??
        (possiblePaths.length === 1 ? possiblePaths[0] : undefined);
      return cleanAxisResult(result, path);
    })
    .sort(compareAxisResults);
}

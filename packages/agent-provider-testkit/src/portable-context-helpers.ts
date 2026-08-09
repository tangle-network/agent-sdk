import type {
  NativeContextBoundary,
  PortableContextPlanRequest,
  PortableContextPlanResult,
} from "@tangle-network/agent-interface";
import { assert, deepEqual } from "./conformance-helpers.js";
import type { PortableContextConformanceCounters } from "./conformance-types.js";




export function assertNoContextEffects(
  before: PortableContextConformanceCounters,
  after: PortableContextConformanceCounters,
  checked: string[],
): void {
  assert(
    after.transfers === before.transfers &&
      after.freshSessions === before.freshSessions &&
      after.nativeContinuations === before.nativeContinuations,
    "context planning or rejection must dispatch no run or session",
    checked,
  );
}

export function assertPortablePlanCoversRequest(
  request: PortableContextPlanRequest,
  result: Extract<PortableContextPlanResult, { status: "ready" }>,
  checked: string[],
): void {
  assert(
    deepEqual(result.plan.source, request.source),
    "context plan source differs from the requested context",
    checked,
  );
  assert(
    deepEqual(result.plan.destination, request.destination),
    "context plan destination differs from the request",
    checked,
  );
  const sourceMessages = [...request.source.messages].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const decisions = [...result.plan.messages].sort((left, right) =>
    left.messageId.localeCompare(right.messageId),
  );
  assert(
    sourceMessages.length === decisions.length,
    "context plan must decide every source message",
    checked,
  );
  for (let index = 0; index < sourceMessages.length; index++) {
    const message = sourceMessages[index];
    const decision = decisions[index];
    assert(
      message?.id === decision?.messageId,
      "context plan message ids differ from the source",
      checked,
    );
    const partIndexes = decision?.parts
      .map((part) => part.partIndex)
      .sort((left, right) => left - right);
    assert(
      deepEqual(
        partIndexes,
        message?.parts.map((_, partIndex) => partIndex),
      ),
      `context plan must decide every part of message ${message?.id ?? "unknown"}`,
      checked,
    );
  }
}

export function differentBoundary(boundary: NativeContextBoundary): NativeContextBoundary {
  switch (boundary.kind) {
    case "token":
      return { kind: "token", token: `${boundary.token}-different` };
    case "revision":
      return { kind: "revision", revision: `${boundary.revision}-different` };
    case "digest":
      return {
        kind: "digest",
        digest:
          boundary.digest === `sha256:${"0".repeat(64)}`
            ? `sha256:${"1".repeat(64)}`
            : `sha256:${"0".repeat(64)}`,
      };
    case "messages":
      return {
        ...boundary,
        digest:
          boundary.digest === `sha256:${"0".repeat(64)}`
            ? `sha256:${"1".repeat(64)}`
            : `sha256:${"0".repeat(64)}`,
      };
  }
}

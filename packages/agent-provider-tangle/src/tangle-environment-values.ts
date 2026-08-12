import type { AgentEnvironmentStatus, AgentSessionStatus, PlacementInfo } from "@tangle-network/agent-interface/environment-provider";
import type { SandboxInstanceLike } from "./tangle-types.js";

const MAX_IDENTIFIER_LENGTH = 512;

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value.trim() === value
    ? value
    : undefined;
}

export function optionalNonEmptyString(
  value: unknown,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.trim() !== value
  ) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function placementInfoFromLoopPlacement(
  placement: unknown,
  box: SandboxInstanceLike,
): PlacementInfo {
  if (!placement || typeof placement !== "object") {
    return { kind: "sandbox", sandboxId: boundedId(box.id, "sandbox id") };
  }
  const record = placement as Record<string, unknown>;
  if (record.kind !== "sandbox" && record.kind !== "fleet") {
    throw new Error("Tangle placement returned an unsupported kind");
  }
  return {
    kind: record.kind === "fleet" ? "fleet" : "sandbox",
    sandboxId:
      record.kind === "fleet"
        ? undefined
        : boundedOptionalId(record.sandboxId, "sandbox id") ??
          boundedId(box.id, "sandbox id"),
    ...(record.kind === "fleet"
      ? { fleetId: boundedId(record.fleetId, "fleet id") }
      : {}),
    ...(record.machineId !== undefined
      ? { machineId: boundedId(record.machineId, "machine id") }
      : {}),
    ...(record.region !== undefined
      ? { region: boundedId(record.region, "region") }
      : {}),
  };
}

function boundedId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.trim() !== value
  ) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function boundedOptionalId(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : boundedId(value, label);
}

export function statusFromUnknown(status: unknown): AgentEnvironmentStatus {
  if (status === "pending" || status === "provisioning" || status === "running") return status;
  if (status === "stopped" || status === "failed" || status === "expired") return status;
  if (status === "completed" || status === "cancelled") return "stopped";
  // A queued session is admitted work that has not started: pending, not
  // unknown — "unknown" also means "not attributable" in exact-status binding.
  if (status === "queued") return "pending";
  return "unknown";
}

export function sessionStatusFromUnknown(status: unknown): AgentSessionStatus {
  if (status === "completed" || status === "cancelled") return status;
  return statusFromUnknown(status);
}

/**
 * Bind a session-wide status payload to one exact execution.
 *
 * The Sandbox status endpoint reports the whole session. Its execution
 * identity fields — activeExecutionId, latestExecutionId, runControlRef,
 * failureReason.executionId — are the only proof of which execution the
 * lifecycle state describes. A payload that names a different execution, or
 * none, must not be attributed to the exact run, so the result degrades to
 * "unknown" instead of fabricating an execution-scoped answer.
 */
export function executionBoundSessionStatus(
  payload: unknown,
  executionId: string,
): AgentSessionStatus {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const sessionStatus = sessionStatusFromUnknown(record.status);
  const active = nonEmptyString(record.activeExecutionId);
  const latest = nonEmptyString(record.latestExecutionId);
  const admitted =
    record.runControlRef && typeof record.runControlRef === "object"
      ? nonEmptyString(
          (record.runControlRef as Record<string, unknown>).executionId,
        )
      : undefined;
  const failed =
    record.failureReason && typeof record.failureReason === "object"
      ? nonEmptyString(
          (record.failureReason as Record<string, unknown>).executionId,
        )
      : undefined;
  // An attributed failure outranks liveness: failureReason.executionId is the
  // only field that names the execution its state describes, so it decides
  // the failed case in both directions. Naming this execution proves the
  // failure; naming another execution proves the failed state is not this
  // run's, even when a contradictory payload also marks this execution live.
  if (sessionStatus === "failed" && failed !== undefined) {
    return failed === executionId ? "failed" : "unknown";
  }
  // A live execution owns the session's current state; any other live
  // execution means this payload says nothing exact about the bound run.
  if (active !== undefined) {
    return active === executionId ? sessionStatus : "unknown";
  }
  // With nothing live, the state belongs to the newest execution. Trust the
  // admitted-run reference only when no newer execution is named.
  if (latest === executionId) return sessionStatus;
  if (latest === undefined && admitted === executionId) return sessionStatus;
  return "unknown";
}

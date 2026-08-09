import type { AgentEnvironmentStatus, AgentSessionStatus, PlacementInfo } from "@tangle-network/agent-interface/environment-provider";
import type { SandboxInstanceLike } from "./tangle-types.js";
import { assertBoundedJson } from "./tangle-contract-safety.js";

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

export function checkpointIdFromResult(result: unknown): string {
  assertBoundedJson(result);
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const id = record.checkpointId ?? record.id;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > MAX_IDENTIFIER_LENGTH ||
    id.trim() !== id
  ) {
    throw new Error("sandbox checkpoint returned no checkpoint id");
  }
  return id;
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
  return "unknown";
}

export function sessionStatusFromUnknown(status: unknown): AgentSessionStatus {
  if (status === "completed" || status === "cancelled") return status;
  return statusFromUnknown(status);
}

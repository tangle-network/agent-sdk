import { randomUUID } from "node:crypto";
import {
  EnvironmentProviderError,
  type CheckpointRef,
  type CheckpointRequest,
  type CreateAgentEnvironmentInput,
  type ForkRequest,
} from "@tangle-network/agent-interface/environment-provider";
import type { BridgeSandboxVendor, BridgeVendorSnapshots } from "./vendor.js";

/**
 * Vendor-snapshot checkpointing: the portable seam between the optional
 * `AgentEnvironment.checkpoint`/`fork` surface and a vendor's snapshot
 * lifecycle. A vendor without {@link BridgeVendorSnapshots} refuses both,
 * exactly as it refuses every capability it cannot honor.
 */

/** The vendor snapshot lifecycle, or a refusal naming the vendor. */
export function vendorSnapshots(vendor: BridgeSandboxVendor): BridgeVendorSnapshots {
  if (vendor.snapshots === undefined) {
    throw new EnvironmentProviderError("refused", `vendor ${vendor.name} exposes no snapshot lifecycle`, { provider: vendor.name });
  }
  return vendor.snapshots;
}

/** Snapshot metadata must be string-valued, exactly like vendor sandbox tags. */
function snapshotMetadata(metadata: Record<string, unknown> | undefined, provider: string): Record<string, string> | undefined {
  if (metadata === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value !== "string") {
      throw new EnvironmentProviderError("refused", `snapshot metadata holds string values; ${key} is not a string`, { path: `metadata.${key}`, provider });
    }
    out[key] = value;
  }
  return out;
}

/** A checkpoint name that cannot collide with a caller-chosen vendor snapshot name. */
export function checkpointSnapshotName(name: string | undefined): string {
  return name ?? `tangle-ckpt-${randomUUID()}`;
}

/** Snapshot one running sandbox and return the portable checkpoint reference. */
export async function createVendorSnapshot(
  vendor: BridgeSandboxVendor,
  sandboxId: string,
  options?: CheckpointRequest & { signal?: AbortSignal },
): Promise<CheckpointRef> {
  const snapshots = vendorSnapshots(vendor);
  const request = options === undefined
    ? {}
    : {
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.metadata === undefined ? {} : { metadata: snapshotMetadata(options.metadata, vendor.name) }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      };
  const record = await snapshots.create(sandboxId, Object.keys(request).length === 0 ? undefined : request);
  if (typeof record.id !== "string" || record.id.length === 0) {
    throw new EnvironmentProviderError("provision_failed", `vendor ${vendor.name} returned no snapshot id for ${sandboxId}`, { provider: vendor.name });
  }
  return {
    id: record.id,
    provider: vendor.name,
    ...(record.createdAt === undefined ? {} : { metadata: { createdAt: record.createdAt } }),
  };
}

/** A fork must restore this vendor's snapshot; a foreign checkpoint reference is refused. */
export function assertForkableCheckpoint(ref: CheckpointRef, vendorName: string): void {
  if (typeof ref.id !== "string" || ref.id.length === 0) {
    throw new EnvironmentProviderError("invalid_input", "a checkpoint reference carries a non-empty id", { path: "checkpoint.id", provider: vendorName });
  }
  if (ref.provider !== undefined && ref.provider !== vendorName) {
    throw new EnvironmentProviderError("refused", `checkpoint from provider ${ref.provider} cannot restore on ${vendorName}`, { path: "checkpoint.provider", provider: vendorName });
  }
}

/**
 * The create input a fork runs with: the source environment's input, minus
 * everything the snapshot already carries. A repository clone would overwrite
 * the snapshot's workspace, and a caller-chosen environment would boot a
 * different image than the checkpoint captured; both are dropped, while the
 * requested working directory keeps its placement.
 */
export function forkCreateInput(source: CreateAgentEnvironmentInput, request?: ForkRequest): CreateAgentEnvironmentInput {
  const { workspace, name, metadata, signal, ...rest } = source;
  const cwd = workspace?.cwd;
  return {
    ...rest,
    ...(request?.name === undefined
      ? (name === undefined ? {} : { name })
      : { name: request.name }),
    ...(metadata === undefined && request?.metadata === undefined
      ? {}
      : { metadata: { ...metadata, ...request?.metadata } }),
    ...(cwd === undefined ? {} : { workspace: { cwd } }),
  };
}

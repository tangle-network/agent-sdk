import type { CreateSandboxOptions } from "@tangle-network/sandbox";
import type { ResourceRequest } from "@tangle-network/agent-interface/environment-provider";
import type { ResourceProfile } from "@tangle-network/agent-interface";
import { boundedIdentifier } from "./tangle-contract-safety.js";

/** Megabytes in one gibibyte, the unit Sandbox states disk in. */
const MB_PER_GIB = 1_024;

/**
 * Number of accelerator devices a single-class GPU request means. Sandbox
 * documents 1 as the default device count for an accelerator request that
 * states only its class, so a request naming one class is one device.
 */
const SINGLE_ACCELERATOR_COUNT = 1;

/**
 * Translate the contract's resource request into the Sandbox request shape.
 *
 * The two shapes name the same quantities differently — `cpu`/`memoryMb`/
 * `diskMb` against `cpuCores`/`memoryMB`/`diskGB` — so a request passed
 * through unchanged reaches the service as unknown fields and provisions a
 * sandbox the caller never asked for. Disk is stated in gibibytes on the wire,
 * and a request that is not a whole number of gibibytes is refused instead of
 * being rounded to a size the caller did not name.
 */
export function sandboxResourcesFromResourceRequest(
  resources: ResourceRequest | undefined,
): CreateSandboxOptions["resources"] | undefined {
  if (resources === undefined) return undefined;
  const { cpu, memoryMb, diskMb, gpu } = resources;
  if (cpu !== undefined && (!Number.isSafeInteger(cpu) || cpu < 1)) {
    throw new Error("Tangle resource cpu must be a positive safe integer");
  }
  if (
    memoryMb !== undefined &&
    (!Number.isSafeInteger(memoryMb) || memoryMb < 1)
  ) {
    throw new Error("Tangle resource memoryMb must be a positive safe integer");
  }
  if (diskMb !== undefined) {
    if (!Number.isSafeInteger(diskMb) || diskMb < 1) {
      throw new Error("Tangle resource diskMb must be a positive safe integer");
    }
    if (diskMb % MB_PER_GIB !== 0) {
      throw new Error(
        "Tangle resource diskMb must be a whole number of gibibytes",
      );
    }
  }
  if (gpu !== undefined) boundedIdentifier(gpu, "Tangle GPU");
  const mapped: NonNullable<CreateSandboxOptions["resources"]> = {
    ...(cpu === undefined ? {} : { cpuCores: cpu }),
    ...(memoryMb === undefined ? {} : { memoryMB: memoryMb }),
    ...(diskMb === undefined ? {} : { diskGB: diskMb / MB_PER_GIB }),
    ...(gpu === undefined
      ? {}
      : { accelerator: { kind: gpu, count: SINGLE_ACCELERATOR_COUNT } }),
  };
  return Object.keys(mapped).length === 0 ? undefined : mapped;
}

/**
 * The compute shape the caller asked for, in the observation's units.
 *
 * This is the request, never a measurement, so it carries no freshness state:
 * the contract holds it beside the freshness-tagged effective profile so the
 * two can be compared.
 */
export function requestedResourceProfile(
  resources: ResourceRequest | undefined,
): ResourceProfile | undefined {
  if (resources === undefined) return undefined;
  // The Sandbox mapping owns the validation, so a profile is only reported for
  // a request the adapter would actually send.
  sandboxResourcesFromResourceRequest(resources);
  const { cpu, memoryMb, diskMb, gpu } = resources;
  const profile: ResourceProfile = {
    ...(cpu === undefined ? {} : { cpu }),
    ...(memoryMb === undefined ? {} : { memoryMb }),
    ...(diskMb === undefined ? {} : { diskMb }),
    ...(gpu === undefined
      ? {}
      : { accelerator: { kind: gpu, count: SINGLE_ACCELERATOR_COUNT } }),
  };
  return Object.keys(profile).length === 0 ? undefined : profile;
}

import {
  AccountUsageSchema,
  AgentEnvironmentObservationSchema,
  SafeEndpointSchema,
} from "@tangle-network/agent-interface";
import type {
  AgentEnvironmentObservation,
  ComputeBilling,
  EnvironmentLifecycle,
  Observation,
  ObservationProvenance,
  PlacementDescriptor,
  ProviderIdentity,
  ResourceProfile,
  ResourceUseSample,
  SafeEndpoint,
} from "@tangle-network/agent-interface";
import type {
  SandboxClientLike,
  SandboxConnectionLike,
  SandboxInstanceLike,
  SandboxResourceUsageLike,
} from "./tangle-types.js";
import { placementInfoFromLoopPlacement, statusFromUnknown } from "./tangle-environment-values.js";
import { awaitWithSignal } from "./tangle-contract-safety.js";
import { transportFailureReason } from "./tangle-failure-reason.js";
import type { ExecutionUsageLog } from "./tangle-usage-log.js";

/** Everything one observation reads, resolved when the environment is composed. */
export interface TangleObservationSources {
  box: SandboxInstanceLike;
  client: SandboxClientLike;
  provider: string;
  environmentId: string;
  /** Compute shape the caller asked for. Absent on an environment rebuilt by id. */
  requestedResources?: ResourceProfile;
  usageLog: ExecutionUsageLog;
}

/**
 * Which observation surfaces this environment can put a value on.
 *
 * A flag is true only when a concrete source backs the surface for THIS
 * sandbox. `identity` and `lifecycle` are unconditional because the sandbox id
 * and status are always readable. `modelUsage` is unconditional for a
 * different reason: the adapter measures the usage of every execution that
 * runs through the handle, and reports the surface as unavailable until one
 * completes. Every other flag rests on a source that can be absent.
 */
export interface ObservationSurfaceSupport {
  identity: boolean;
  lifecycle: boolean;
  endpoint: boolean;
  placement: boolean;
  resources: boolean;
  resourceUse: boolean;
  modelUsage: boolean;
  computeBilling: boolean;
  accountUsage: boolean;
}

export function observationSurfaceSupport(
  box: SandboxInstanceLike,
  client: SandboxClientLike,
  requestedResources: ResourceProfile | undefined,
): ObservationSurfaceSupport {
  const resourceUse = typeof box.resourceUsage === "function";
  return {
    identity: true,
    lifecycle: true,
    endpoint: readSandboxMember(() => safeEndpointFromConnection(box.connection)) !== undefined,
    placement: typeof client.describePlacement === "function",
    resources: resourceUse || requestedResources !== undefined,
    resourceUse,
    modelUsage: true,
    computeBilling: readSandboxMember(() => computeBillingFromLease(box)) !== undefined,
    accountUsage:
      typeof client.usage === "function" &&
      typeof client.subscription === "function",
  };
}

/**
 * Account usage and the client-side placement surface are the only observation
 * facts a client can establish before a sandbox exists. The rest rest on one
 * environment's data, so a provider-stage document keeps them at the declared
 * ceiling and each concrete sandbox measures them.
 */
export function clientObservationSurfaceSupport(
  client: SandboxClientLike,
): ObservationSurfaceSupport {
  return {
    identity: true,
    lifecycle: true,
    endpoint: true,
    placement: typeof client.describePlacement === "function",
    resources: true,
    resourceUse: true,
    modelUsage: true,
    computeBilling: true,
    accountUsage:
      typeof client.usage === "function" &&
      typeof client.subscription === "function",
  };
}

/** Read an SDK accessor that can throw before its sandbox is usable. */
function readSandboxMember<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * Read the credential-free network location of the sandbox runtime.
 *
 * Only the scheme, host, and explicit port of the runtime URL are carried.
 * Userinfo, path, and query are dropped, and the bearer beside the URL is
 * never read, so an endpoint payload cannot transport a credential. A port the
 * URL leaves to its scheme default is omitted rather than inferred. The result
 * is held to the contract's own endpoint schema, so a runtime URL the contract
 * refuses reads as no endpoint instead of failing the whole observation.
 */
export function safeEndpointFromConnection(
  connection: SandboxConnectionLike | undefined,
): SafeEndpoint | undefined {
  const runtimeUrl = connection?.runtimeUrl;
  if (typeof runtimeUrl !== "string" || runtimeUrl.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(runtimeUrl);
  } catch {
    return undefined;
  }
  const scheme = parsed.protocol.replace(/:$/, "");
  const host = parsed.hostname;
  if (scheme.length === 0 || host.length === 0) return undefined;
  const port = parsed.port === "" ? undefined : Number.parseInt(parsed.port, 10);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
    return undefined;
  }
  const endpoint = SafeEndpointSchema.safeParse({
    scheme,
    host,
    ...(port === undefined ? {} : { port }),
  });
  return endpoint.success ? endpoint.data : undefined;
}

/**
 * Hold one surface to the schema the contract states for it.
 *
 * An observation is composed of independent surfaces, and every value on them
 * comes from the platform. A value the contract refuses degrades that surface
 * alone, so one unbounded field cannot destroy the lifecycle, endpoint,
 * placement, resource, usage, and billing facts beside it.
 */
function heldToContract<T>(
  schema: { safeParse(value: unknown): { success: boolean } },
  observation: Observation<T>,
  surface: string,
): Observation<T> {
  if (schema.safeParse(observation).success) return observation;
  return {
    state: "unavailable",
    reason: `the sandbox reported a ${surface} the observation contract refuses`,
  };
}

const observationShape = AgentEnvironmentObservationSchema.shape;
const placementShape = observationShape.placement.unwrap().shape;
const resourcesShape = observationShape.resources.unwrap().shape;
const resourceUseShape = observationShape.resourceUse.unwrap().shape;
const accountShape = AccountUsageSchema.shape;

/** Build the normalized, freshness-tagged observation of one environment. */
export async function observeTangleEnvironment(
  sources: TangleObservationSources,
  options?: { signal?: AbortSignal },
): Promise<AgentEnvironmentObservation> {
  const { box, client, provider, environmentId } = sources;
  options?.signal?.throwIfAborted();
  const refreshFailure = await refreshBeforeObservation(box, options);
  options?.signal?.throwIfAborted();
  const capturedAt = new Date().toISOString();
  // The subject binds a live observation to its replay, so it carries only the
  // identifiers both a create handle and a handle rebuilt by id can produce.
  // The Sandbox client cannot read back the agent backend a create call named,
  // so naming it here would deny that binding for the same sandbox.
  const subject: ProviderIdentity = { provider, environmentId };
  const sample = await readResourceSample(box, options);
  options?.signal?.throwIfAborted();
  const account = await readAccountObservations(client, capturedAt, options);
  options?.signal?.throwIfAborted();
  const observation: AgentEnvironmentObservation = {
    subject,
    capturedAt,
    identity: {
      state: "known",
      value: subject,
      provenance: reportedAt(capturedAt, "sandbox-instance"),
    },
    lifecycle: heldToContract(
      observationShape.lifecycle,
      freshOrStale(
        lifecycleFromSandbox(box),
        reportedAt(capturedAt, "sandbox-instance"),
        refreshFailure,
      ),
      "lifecycle",
    ),
    endpoint: endpointObservation(box, capturedAt, refreshFailure),
    placement: {
      verified: heldToContract(
        placementShape.verified,
        await verifiedPlacement(box, client, capturedAt, options),
        "placement",
      ),
    },
    resources: {
      ...(sources.requestedResources === undefined
        ? {}
        : { requested: sources.requestedResources }),
      effective: heldToContract(
        resourcesShape.effective,
        effectiveResources(box, sample, capturedAt),
        "compute shape",
      ),
    },
    resourceUse: {
      current: heldToContract(
        resourceUseShape.current,
        currentResourceUse(sample),
        "resource sample",
      ),
      peak: heldToContract(
        resourceUseShape.peak,
        peakResourceUse(sample),
        "resource sample",
      ),
    },
    modelUsage: heldToContract(
      observationShape.modelUsage,
      modelUsageObservation(sources.usageLog),
      "token usage",
    ),
    computeBilling: heldToContract(
      observationShape.computeBilling,
      computeBillingObservation(box, capturedAt),
      "compute cost",
    ),
    accountUsage: account,
  };
  options?.signal?.throwIfAborted();
  return AgentEnvironmentObservationSchema.parse(observation);
}

function reportedAt(observedAt: string, source: string): ObservationProvenance {
  return { origin: "reported", observedAt, source };
}

/**
 * Tag a value the sandbox reported as stale when the refresh that would have
 * renewed it failed. The value stays visible with the transport's own reason,
 * so a caller reads why it is old instead of reading it as current.
 */
function freshOrStale<T>(
  value: T,
  provenance: ObservationProvenance,
  staleReason: string | undefined,
): Observation<T> {
  return staleReason === undefined
    ? { state: "known", value, provenance }
    : { state: "stale", value, provenance, reason: staleReason };
}

async function refreshBeforeObservation(
  box: SandboxInstanceLike,
  options: { signal?: AbortSignal } | undefined,
): Promise<string | undefined> {
  if (typeof box.refresh !== "function") {
    return "the Sandbox client cannot refresh this environment";
  }
  try {
    await awaitWithSignal(
      (box.refresh as unknown as (signal?: AbortSignal) => Promise<void>)(
        options?.signal,
      ),
      options?.signal,
    );
    return undefined;
  } catch (error) {
    options?.signal?.throwIfAborted();
    return transportFailureReason("environment refresh", error);
  }
}

function lifecycleFromSandbox(box: SandboxInstanceLike): EnvironmentLifecycle {
  const scheduledAt = isoTimestamp(readSandboxMember(() => box.expiresAt));
  return {
    status: statusFromUnknown(readSandboxMember(() => box.status)),
    // The platform retires the sandbox at its lifetime bound, so the expiry is
    // a scheduled cleanup. It is unconfirmed until the sandbox actually stops.
    ...(scheduledAt === undefined
      ? {}
      : { cleanup: { policy: "scheduled" as const, scheduledAt } }),
  };
}

function endpointObservation(
  box: SandboxInstanceLike,
  capturedAt: string,
  refreshFailure: string | undefined,
): Observation<SafeEndpoint> {
  const connection = readSandboxMember(() => box.connection);
  const endpoint = safeEndpointFromConnection(connection);
  if (endpoint === undefined) {
    const stated =
      typeof connection?.runtimeUrl === "string" && connection.runtimeUrl.length > 0;
    return {
      state: "unavailable",
      reason: stated
        ? "the sandbox reported a runtime URL the observation contract refuses"
        : "the sandbox reports no runtime URL for this environment",
    };
  }
  return heldToContract(
    observationShape.endpoint,
    freshOrStale(endpoint, reportedAt(capturedAt, "sandbox-instance"), refreshFailure),
    "runtime endpoint",
  );
}

async function verifiedPlacement(
  box: SandboxInstanceLike,
  client: SandboxClientLike,
  capturedAt: string,
  options: { signal?: AbortSignal } | undefined,
): Promise<Observation<PlacementDescriptor>> {
  if (typeof client.describePlacement !== "function") {
    return {
      state: "unavailable",
      reason: "the Sandbox client cannot describe placement",
    };
  }
  try {
    const described = await awaitWithSignal(
      Promise.resolve(client.describePlacement(box)),
      options?.signal,
    );
    const placement = placementInfoFromLoopPlacement(described, box);
    return {
      state: "known",
      value: {
        kind: placement.kind,
        ...(placement.sandboxId === undefined ? {} : { sandboxId: placement.sandboxId }),
        ...(placement.fleetId === undefined ? {} : { fleetId: placement.fleetId }),
        ...(placement.machineId === undefined ? {} : { machineId: placement.machineId }),
        ...(placement.region === undefined ? {} : { region: placement.region }),
      },
      provenance: reportedAt(capturedAt, "sandbox-placement"),
    };
  } catch (error) {
    options?.signal?.throwIfAborted();
    return {
      state: "unavailable",
      reason: transportFailureReason("placement lookup", error),
    };
  }
}

/**
 * One cgroup sample, or the reason there is none. A sample is read once and
 * shared by the effective-resource and resource-use surfaces so both describe
 * the same instant.
 */
type ResourceSample =
  | { measured: true; sample: SandboxResourceUsageLike; observedAt: string }
  | { measured: false; reason: string };

async function readResourceSample(
  box: SandboxInstanceLike,
  options: { signal?: AbortSignal } | undefined,
): Promise<ResourceSample> {
  if (typeof box.resourceUsage !== "function") {
    return {
      measured: false,
      reason: "the Sandbox client reports no runtime resource usage",
    };
  }
  try {
    const sample = await awaitWithSignal(box.resourceUsage(), options?.signal);
    if (sample === null || sample === undefined) {
      return {
        measured: false,
        reason: "the sandbox host collected no cgroup statistics",
      };
    }
    const observedAt = isoTimestamp(
      Number.isFinite(sample.sampledAtMs) ? new Date(sample.sampledAtMs) : undefined,
    );
    if (observedAt === undefined) {
      return {
        measured: false,
        reason: "the sandbox reported a resource sample without a valid sample time",
      };
    }
    return { measured: true, sample, observedAt };
  } catch (error) {
    options?.signal?.throwIfAborted();
    return {
      measured: false,
      reason: transportFailureReason("resource usage read", error),
    };
  }
}

function effectiveResources(
  box: SandboxInstanceLike,
  sample: ResourceSample,
  capturedAt: string,
): Observation<ResourceProfile> {
  const memoryMb = sample.measured
    ? positiveInteger(sample.sample.memoryLimitMb)
    : undefined;
  const accelerator = readSandboxMember(() => box.gpuLease?.accelerator);
  const acceleratorProfile =
    accelerator !== undefined &&
    typeof accelerator.kind === "string" &&
    accelerator.kind.length > 0 &&
    positiveInteger(accelerator.count) !== undefined
      ? {
          kind: accelerator.kind,
          count: accelerator.count,
          ...(positiveInteger(accelerator.memoryMB) === undefined
            ? {}
            : { memoryMb: accelerator.memoryMB as number }),
        }
      : undefined;
  if (memoryMb === undefined && acceleratorProfile === undefined) {
    // Sandbox states no effective CPU or disk anywhere, and an unlimited
    // memory cgroup states no ceiling, so there is nothing to report rather
    // than a ceiling of zero.
    return {
      state: "unavailable",
      reason: sample.measured
        ? "the sandbox cgroup reports no memory limit and no accelerator is attached"
        : sample.reason,
    };
  }
  return {
    state: "known",
    value: {
      ...(memoryMb === undefined ? {} : { memoryMb }),
      ...(acceleratorProfile === undefined ? {} : { accelerator: acceleratorProfile }),
    },
    provenance:
      memoryMb === undefined
        ? reportedAt(capturedAt, "sandbox-gpu-lease")
        : {
            origin: "measured",
            observedAt: sample.measured ? sample.observedAt : capturedAt,
            source: "sandbox-cgroup",
          },
  };
}

function currentResourceUse(sample: ResourceSample): Observation<ResourceUseSample> {
  if (!sample.measured) return { state: "unavailable", reason: sample.reason };
  const memoryMb = nonNegativeNumber(sample.sample.memoryCurrentMb);
  if (memoryMb === undefined) {
    return {
      state: "unavailable",
      reason: "the sandbox reported an invalid current memory sample",
    };
  }
  // The cgroup reports cumulative CPU microseconds, which is not a utilization
  // figure, and reports no disk or accelerator use at all. Deriving a rate
  // from one sample would publish an unmeasured number, so only memory is
  // carried.
  return {
    state: "known",
    value: { memoryMb },
    provenance: {
      origin: "measured",
      observedAt: sample.observedAt,
      source: "sandbox-cgroup",
    },
  };
}

function peakResourceUse(sample: ResourceSample): Observation<ResourceUseSample> {
  if (!sample.measured) return { state: "unavailable", reason: sample.reason };
  const memoryMb = nonNegativeNumber(sample.sample.memoryPeakMb);
  if (memoryMb === undefined) {
    return {
      state: "unavailable",
      reason: "the sandbox cgroup reports no peak memory high-water mark",
    };
  }
  return {
    state: "known",
    value: { memoryMb },
    provenance: {
      origin: "measured",
      observedAt: sample.observedAt,
      source: "sandbox-cgroup",
    },
  };
}

function modelUsageObservation(
  usageLog: ExecutionUsageLog,
): NonNullable<AgentEnvironmentObservation["modelUsage"]> {
  const latest = usageLog.latest();
  if (latest === undefined) {
    return {
      state: "unavailable",
      reason: "no execution measured token usage through this environment handle",
    };
  }
  // The provenance source names the execution the usage belongs to, because
  // Sandbox measures usage per execution and never for the environment.
  return {
    state: "known",
    value: latest.usage,
    provenance: {
      origin: "reported",
      observedAt: latest.observedAt,
      source: latest.executionId,
    },
  };
}

/**
 * Compute cost Sandbox charges for this environment.
 *
 * Sandbox prices an attached GPU lease and nothing else: it publishes no
 * per-sandbox container compute cost. A settled lease carries its billed
 * amount; a running lease carries the running estimate, which is reported with
 * an estimated origin so it is never read as a settled charge.
 */
function computeBillingFromLease(
  box: SandboxInstanceLike,
): { billing: ComputeBilling; origin: "reported" | "estimated" } | undefined {
  const lease = readSandboxMember(() => box.gpuLease);
  if (lease === undefined) return undefined;
  const billed = nonNegativeNumber(lease.billing?.customerCostUsd);
  if (billed !== undefined) {
    return { billing: { amount: billed, currency: "USD" }, origin: "reported" };
  }
  const estimated = nonNegativeNumber(lease.estimatedCustomerCostUsd);
  if (estimated !== undefined) {
    return { billing: { amount: estimated, currency: "USD" }, origin: "estimated" };
  }
  return undefined;
}

function computeBillingObservation(
  box: SandboxInstanceLike,
  capturedAt: string,
): Observation<ComputeBilling> {
  const resolved = computeBillingFromLease(box);
  if (resolved === undefined) {
    return {
      state: "unavailable",
      reason:
        "Sandbox reports compute cost only for an attached GPU lease, and this environment has none",
    };
  }
  return {
    state: "known",
    value: resolved.billing,
    provenance: {
      origin: resolved.origin,
      observedAt: capturedAt,
      source: "sandbox-gpu-lease",
    },
  };
}

async function readAccountObservations(
  client: SandboxClientLike,
  capturedAt: string,
  options: { signal?: AbortSignal } | undefined,
): Promise<NonNullable<AgentEnvironmentObservation["accountUsage"]>> {
  if (typeof client.usage !== "function" || typeof client.subscription !== "function") {
    const reason = "the Sandbox client exposes no account usage or subscription surface";
    return {
      plan: { state: "unavailable", reason },
      credits: { state: "unavailable", reason },
      quota: { state: "unavailable", reason },
      period: { state: "unavailable", reason },
    };
  }
  let subscriptionFailure: string | undefined;
  let subscription: Awaited<ReturnType<NonNullable<SandboxClientLike["subscription"]>>> | undefined;
  try {
    subscription = await awaitWithSignal(client.subscription(), options?.signal);
  } catch (error) {
    options?.signal?.throwIfAborted();
    subscriptionFailure = transportFailureReason("subscription read", error);
  }
  let usageFailure: string | undefined;
  let usage: Awaited<ReturnType<NonNullable<SandboxClientLike["usage"]>>> | undefined;
  try {
    usage = await awaitWithSignal(client.usage(), options?.signal);
  } catch (error) {
    options?.signal?.throwIfAborted();
    usageFailure = transportFailureReason("account usage read", error);
  }
  const provenance = reportedAt(capturedAt, "sandbox-account");
  return {
    plan: heldToContract(
      accountShape.plan,
      planObservation(subscription?.plan, subscriptionFailure, provenance),
      "plan",
    ),
    credits: heldToContract(
      accountShape.credits,
      creditsObservation(subscription, subscriptionFailure, provenance),
      "credit balance",
    ),
    quota: heldToContract(
      accountShape.quota,
      quotaObservation(subscription, usage, subscriptionFailure, usageFailure, provenance),
      "sandbox quota",
    ),
    period: heldToContract(
      accountShape.period,
      periodObservation(usage, usageFailure, provenance),
      "billing period",
    ),
  };
}

function planObservation(
  plan: string | undefined,
  failure: string | undefined,
  provenance: ObservationProvenance,
): Observation<string> {
  if (failure !== undefined) return { state: "unavailable", reason: failure };
  if (typeof plan !== "string" || plan.length === 0) {
    return { state: "unavailable", reason: "the account reports no plan" };
  }
  return { state: "known", value: plan, provenance };
}

function creditsObservation(
  subscription: { creditsAvailableUsd?: number } | undefined,
  failure: string | undefined,
  provenance: ObservationProvenance,
): Observation<{ remaining: number; unit: string }> {
  if (failure !== undefined) return { state: "unavailable", reason: failure };
  const remaining = subscription?.creditsAvailableUsd;
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) {
    return { state: "unavailable", reason: "the account reports no credit balance" };
  }
  if (remaining < 0) {
    // An overage plan can hold a negative balance, which the contract's
    // non-negative remaining credit cannot state. Reporting it as zero would
    // hide a debt, so the value is reported as absent with its cause.
    return {
      state: "unavailable",
      reason: "the account credit balance is negative under an overage plan",
    };
  }
  return { state: "known", value: { remaining, unit: "USD" }, provenance };
}

function quotaObservation(
  subscription: { maxConcurrentSandboxes?: number } | undefined,
  usage: { activeSandboxes?: number } | undefined,
  subscriptionFailure: string | undefined,
  usageFailure: string | undefined,
  provenance: ObservationProvenance,
): Observation<{ limit: number; used: number; remaining: number; unit: string }> {
  const failure = subscriptionFailure ?? usageFailure;
  if (failure !== undefined) return { state: "unavailable", reason: failure };
  const limit = subscription?.maxConcurrentSandboxes;
  const used = usage?.activeSandboxes;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return {
      state: "unavailable",
      reason: "the account states no concurrent sandbox limit",
    };
  }
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0) {
    return {
      state: "unavailable",
      reason: "the account reports no active sandbox count",
    };
  }
  return {
    state: "known",
    value: { limit, used, remaining: Math.max(0, limit - used), unit: "sandboxes" },
    provenance,
  };
}

function periodObservation(
  usage: { periodStart?: Date | string; periodEnd?: Date | string } | undefined,
  failure: string | undefined,
  provenance: ObservationProvenance,
): Observation<{ start: string; end: string }> {
  if (failure !== undefined) return { state: "unavailable", reason: failure };
  const start = isoTimestamp(usage?.periodStart);
  const end = isoTimestamp(usage?.periodEnd);
  if (start === undefined || end === undefined) {
    return { state: "unavailable", reason: "the account reports no billing period" };
  }
  return { state: "known", value: { start, end }, provenance };
}

function isoTimestamp(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  return new Date(time).toISOString();
}

function positiveInteger(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function nonNegativeNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

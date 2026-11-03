import { posix } from "node:path";
import { shellQuote } from "@tangle-network/agent-core/node";
import {
  EnvironmentProviderError,
  type AgentEnvironmentProvider,
  type AgentEnvironmentStatus,
  type ExecResult,
} from "@tangle-network/agent-interface/environment-provider";
import {
  BOX_TEMPLATE_NAME,
  BRIDGE_RUN_TAG,
  createBridgeSandboxProvider,
  envFileLaunch,
  markedExec,
  untilAborted,
  type BridgeSandbox,
  type BridgeSandboxProviderOptions,
  type BridgeSandboxSummary,
  type BridgeSandboxVendor,
} from "@tangle-network/agent-provider-cli-bridge/sandbox";
import type { CallableCompute, InstanceInterface } from "computesdk";

type Instances = CallableCompute["instances"];

/** The computesdk snapshot manager, accepted structurally: `compute({ provider }).snapshot`. */
export interface ComputeSdkSnapshotManager {
  create(
    instanceId: string,
    options?: { name?: string; metadata?: Record<string, unknown> },
  ): Promise<{ id: string; createdAt?: Date | string; metadata?: Record<string, unknown> }>;
}

export interface ComputeSdkProviderOptions extends Omit<BridgeSandboxProviderOptions, "vendor"> {
  /** A computesdk manager with a backing provider set, for example `compute({ provider: e2b({ apiKey }) })`. */
  compute: { instances: Instances; snapshot?: ComputeSdkSnapshotManager };
  /** Template or snapshot id the backing provider boots; defaults to the box template `pnpm build:sandbox-image --target e2b` publishes. */
  template?: string;
}

/** An `AgentEnvironmentProvider` whose environments are sandboxes on any computesdk backing provider, running CLI Bridge from the box image. */
export function createComputeSdkProvider({ compute, template, ...bridge }: ComputeSdkProviderOptions): AgentEnvironmentProvider {
  return createBridgeSandboxProvider({ ...bridge, vendor: computeSdkVendor(compute.instances, compute.snapshot, template ?? BOX_TEMPLATE_NAME) });
}

const NAME = "computesdk";
// computesdk's listing returns no tags, so each sandbox carries its own in its default environment.
const TAGS_ENV = "TANGLE_BRIDGE_TAGS";
const NAME_TAG = "tangle-name";
// computesdk's e2b provider applies a 60 s default to a command given no timeout; markedExec owns the real deadline.
const COMMAND_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function computeSdkVendor(instances: Instances, snapshots: ComputeSdkSnapshotManager | undefined, template: string): BridgeSandboxVendor {
  const lookup = (id: string, signal?: AbortSignal) => untilAborted(vendorCall("connect", () => instances.getById(id)), signal);
  const summary = async (id: string): Promise<BridgeSandboxSummary | undefined> => {
    const instance = await lookup(id);
    const printed = instance === null ? undefined : await vendorCall("list", () => instance.runCommand(`printenv ${TAGS_ENV}`, { timeout: 30_000 }));
    if (instance === null || printed?.exitCode !== 0) return undefined;
    const { [NAME_TAG]: name, ...metadata } = JSON.parse(printed.stdout) as Record<string, string>;
    return { id, status: await lifecycleStatus(instance), metadata, ...(name === undefined ? {} : { name }) };
  };
  return {
    name: NAME,
    // A template id is the portable environment; an image must be box-compatible
    // (built by `pnpm build:sandbox-image --base-image`), and resources and egress
    // mean something different on each backing provider, so both stay refused.
    support: { environment: true, image: true, resources: false, egress: [] },
    ...(snapshots === undefined ? {} : {
      snapshots: {
        async create(sandboxId, options) {
          options?.signal?.throwIfAborted();
          const record = await vendorCall("snapshot", () => snapshots.create(sandboxId, {
            ...(options?.name === undefined ? {} : { name: options.name }),
            ...(options?.metadata === undefined ? {} : { metadata: options.metadata }),
          }));
          const createdAt = record.createdAt instanceof Date ? record.createdAt.toISOString()
            : typeof record.createdAt === "string" ? record.createdAt
            : undefined;
          return { id: record.id, ...(createdAt === undefined ? {} : { createdAt }) };
        },
      },
    }),
    async create(request) {
      const tags = request.name === undefined ? request.metadata : { ...request.metadata, [NAME_TAG]: request.name };
      // computesdk destroys a sandbox that arrives after the signal aborts.
      const instance = await vendorCall("create", () => instances.create({
        ...(request.snapshot === undefined && request.image === undefined ? { templateId: request.environment ?? template } : {}),
        ...(request.snapshot === undefined ? {} : { snapshotId: request.snapshot }),
        ...(request.image === undefined ? {} : { image: request.image }),
        timeout: request.lifetimeMs,
        metadata: tags,
        envs: { ...request.env, [TAGS_ENV]: JSON.stringify(tags) },
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }));
      return computeSdkSandbox(instance, instances, lookup);
    },
    async connect(id, options) {
      const instance = await lookup(id, options?.signal);
      return instance === null ? null : computeSdkSandbox(instance, instances, lookup);
    },
    async list(query, options) {
      const listed = await untilAborted(vendorCall("list", () => instances.list()), options?.signal);
      // A listed entry cannot run commands on every backing provider, so each is reconnected to read its tags.
      const found = await untilAborted(Promise.all(listed.map((entry) => summary(entry.sandboxId))), options?.signal);
      return found.filter((entry): entry is BridgeSandboxSummary =>
        entry !== undefined
        && entry.metadata[BRIDGE_RUN_TAG] !== undefined
        && (query.name === undefined || entry.name === query.name)
        && Object.entries(query.metadata ?? {}).every(([key, value]) => entry.metadata[key] === value));
    },
  };
}

function computeSdkSandbox(instance: InstanceInterface, instances: Instances, lookup: (id: string, signal?: AbortSignal) => Promise<InstanceInterface | null>): BridgeSandbox {
  const id = instance.sandboxId;
  const run = async (script: string, signal?: AbortSignal): Promise<ExecResult> => {
    const { exitCode, stdout, stderr } = await untilAborted(vendorCall("exec", () => instance.runCommand(script, { timeout: COMMAND_TIMEOUT_MS })), signal);
    return { exitCode, stdout, stderr };
  };
  const mustRun = async (script: string, what: string, signal?: AbortSignal): Promise<void> => {
    const result = await run(script, signal);
    if (result.exitCode !== 0) throw new EnvironmentProviderError("transport", `${what} failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 300)}`, { provider: NAME });
  };
  return {
    id,
    exec: (command, options) => markedExec(command, options, NAME, run),
    async spawn(command, options) {
      const launch = envFileLaunch(command, options);
      try {
        await mustRun(launch.prepare, "creating the Bridge env directory");
        await vendorCall("spawn", () => instance.filesystem.writeFile(launch.file, launch.content));
        await mustRun(`nohup sh -c ${shellQuote(launch.launch)} >/dev/null 2>&1 </dev/null &`, "starting the Bridge");
      } catch (error) {
        await run(launch.cleanup).catch(() => undefined);
        throw error;
      }
    },
    read: (path, options) => untilAborted(vendorCall("read", () => instance.filesystem.readFile(path)), options?.signal),
    async write(path, content, options) {
      await mustRun(`mkdir -p ${shellQuote(posix.dirname(path))}`, `creating the parent of ${path}`, options?.signal);
      await untilAborted(vendorCall("write", () => instance.filesystem.writeFile(path, content)), options?.signal);
    },
    endpoint: async (port, options) => ({ url: await untilAborted(vendorCall("endpoint", () => instance.getUrl({ port })), options?.signal) }),
    async status(options) {
      const current = await lookup(id, options?.signal);
      return current === null ? "expired" : lifecycleStatus(current);
    },
    async destroy(options) {
      await untilAborted(vendorCall("destroy", () => instances.destroy(id)), options?.signal);
      // computesdk's destroy resolves even when the backing provider failed to delete.
      if ((await lookup(id, options?.signal)) !== null) {
        throw new EnvironmentProviderError("cleanup_failed", `sandbox ${id} is still present after destroy`, { provider: NAME, cleanupHandle: { environmentId: id, provider: NAME } });
      }
    },
  };
}

async function lifecycleStatus(instance: InstanceInterface): Promise<AgentEnvironmentStatus> {
  const { status } = await vendorCall("status", () => instance.getInfo());
  return status === "running" ? "running" : status === "stopped" ? "stopped" : "failed";
}

async function vendorCall<T>(operation: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof EnvironmentProviderError || (error instanceof Error && error.name === "AbortError")) throw error;
    const message = error instanceof Error ? error.message : String(error);
    // computesdk providers rewrite vendor errors into plain messages, so the message is all there is to classify.
    const code = /authentication failed|unauthori[sz]ed|api key/i.test(message) ? "auth_failed"
      : /quota|rate limit/i.test(message) ? "capacity"
        : operation === "create" ? "provision_failed" : "transport";
    throw new EnvironmentProviderError(code, `computesdk ${operation}: ${message}`, { provider: NAME, cause: error });
  }
}

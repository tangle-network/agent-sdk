import {
  EnvironmentProviderError,
  type AgentEnvironmentProvider,
  type AgentEnvironmentStatus,
  type EnvironmentProviderErrorCode,
} from "@tangle-network/agent-interface/environment-provider";
import {
  BOX_TEMPLATE_NAME,
  BRIDGE_RUN_TAG,
  createBridgeSandboxProvider,
  type BridgeSandbox,
  type BridgeSandboxProviderOptions,
  type BridgeSandboxVendor,
} from "@tangle-network/agent-provider-cli-bridge/sandbox";
import * as e2b from "e2b";

export interface E2BProviderOptions extends Omit<BridgeSandboxProviderOptions, "vendor"> {
  /** Defaults to `E2B_API_KEY`, which the e2b SDK reads. */
  apiKey?: string;
  /** Template name or id; defaults to the box template `pnpm build:sandbox-image --target e2b` publishes. */
  template?: string;
}

/** An `AgentEnvironmentProvider` whose environments are E2B sandboxes running CLI Bridge from the box template. */
export function createE2BProvider({ apiKey, template, ...bridge }: E2BProviderOptions): AgentEnvironmentProvider {
  return createBridgeSandboxProvider({ ...bridge, vendor: e2bVendor({ apiKey, template }) });
}

// E2B sandboxes carry no name of their own; SandboxInfo.name is the template's.
const NAME_TAG = "tangle-name";

type Guard = <T>(work: Promise<T>, code: EnvironmentProviderErrorCode) => Promise<T>;

export function e2bVendor({ apiKey, template }: { apiKey?: string; template?: string } = {}): BridgeSandboxVendor {
  const auth = apiKey === undefined ? {} : { apiKey };
  const guard: Guard = (work, code) => work.catch((error: unknown) => {
    throw vendorError(error, code, apiKey === undefined ? [] : [apiKey]);
  });
  const listAll = async (metadata: Record<string, string>): Promise<e2b.SandboxInfo[]> => {
    const paginator = e2b.Sandbox.list({ ...auth, query: { metadata } });
    const infos: e2b.SandboxInfo[] = [];
    while (paginator.hasNext) infos.push(...(await paginator.nextItems()));
    return infos;
  };
  return {
    name: "e2b",
    // CPU and memory are fixed when the template is built; egress allowlists are unproven live.
    support: { environment: true, image: false, resources: false, egress: [] },
    async create(request) {
      const metadata = request.name === undefined ? request.metadata : { ...request.metadata, [NAME_TAG]: request.name };
      const created = e2b.Sandbox.create(request.environment ?? template ?? BOX_TEMPLATE_NAME, {
        ...auth, metadata, envs: request.env, timeoutMs: request.lifetimeMs, signal: request.signal,
      }).catch(async (error: unknown) => {
        // An aborted create request can still provision server-side; the run tag finds what arrived.
        if (!request.signal?.aborted) throw error;
        const arrived = await listAll({ [BRIDGE_RUN_TAG]: request.metadata[BRIDGE_RUN_TAG]! }).catch(() => []);
        await Promise.all(arrived.map((info) => e2b.Sandbox.kill(info.sandboxId, auth).catch(() => undefined)));
        throw error;
      });
      return e2bSandbox(await guard(created, "provision_failed"), guard);
    },
    async connect(id, options) {
      const sandbox = await guard(e2b.Sandbox.connect(id, { ...auth, ...options }).catch(nullIfGone), "transport");
      return sandbox === null ? null : e2bSandbox(sandbox, guard);
    },
    async list(query) {
      const infos = await guard(listAll(query.metadata ?? {}), "transport");
      return infos
        .filter((info) => query.name === undefined || info.metadata[NAME_TAG] === query.name)
        .map(({ sandboxId, state, metadata: { [NAME_TAG]: name, ...metadata } }) => ({
          id: sandboxId, status: lifecycleStatus(state), metadata, ...(name === undefined ? {} : { name }),
        }));
    },
  };
}

function nullIfGone(error: unknown): null {
  if (error instanceof e2b.SandboxNotFoundError) return null;
  throw error;
}

function lifecycleStatus(state: e2b.SandboxInfo["state"] | undefined): AgentEnvironmentStatus {
  return state === undefined ? "expired" : state === "running" ? "running" : "stopped";
}

function e2bSandbox(sandbox: e2b.Sandbox, guard: Guard): BridgeSandbox {
  // Background start yields a pid, so a timeout or abort kills the remote process rather than only the request.
  const start = (command: string, envs?: Record<string, string>, cwd?: string) =>
    sandbox.commands.run(command, { background: true, timeoutMs: 0, ...(envs && { envs }), ...(cwd && { cwd }) });
  return {
    id: sandbox.sandboxId,
    async exec(command, options) {
      options?.signal?.throwIfAborted();
      const handle = await guard(start(command, options?.env, options?.cwd), "transport");
      let timer: NodeJS.Timeout | undefined;
      let onAbort = (): void => undefined;
      const stopped = new Promise<never>((_, reject) => {
        if (options?.timeoutMs !== undefined) timer = setTimeout(() => reject(new EnvironmentProviderError("timeout", `exec exceeded ${options.timeoutMs} ms`, { provider: "e2b" })), options.timeoutMs);
        onAbort = () => reject(new DOMException("exec aborted", "AbortError"));
        options?.signal?.addEventListener("abort", onAbort, { once: true });
      });
      try {
        const { exitCode, stdout, stderr } = await Promise.race([handle.wait(), stopped]);
        return { exitCode, stdout, stderr };
      } catch (error) {
        if (error instanceof e2b.CommandExitError) return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr };
        await handle.kill().catch(() => undefined);
        return guard(Promise.reject(error), "transport");
      } finally {
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onAbort);
      }
    },
    async spawn(command, options) {
      const handle = await guard(start(`${command} >/tmp/bridge.log 2>&1`, options.env, options.cwd), "provision_failed");
      await handle.disconnect();
    },
    read: (path, options) => guard(sandbox.files.read(path, options), "transport"),
    write: async (path, content, options) => void (await guard(sandbox.files.write(path, content, options), "transport")),
    endpoint: async (port) => ({ url: `https://${sandbox.getHost(port)}` }),
    status: async (options) => lifecycleStatus((await guard(sandbox.getInfo(options).catch(nullIfGone), "transport"))?.state),
    // kill resolves false for a sandbox that is already gone.
    destroy: async (options) => void (await guard(sandbox.kill(options), "cleanup_failed")),
  };
}

function vendorError(error: unknown, fallback: EnvironmentProviderErrorCode, secrets: readonly string[]): unknown {
  if (error instanceof EnvironmentProviderError || (error instanceof Error && error.name === "AbortError")) return error;
  const code: EnvironmentProviderErrorCode =
    error instanceof e2b.AuthenticationError ? "auth_failed"
    : error instanceof e2b.RateLimitError || error instanceof e2b.ServiceBusyError ? "capacity"
    : error instanceof e2b.NotFoundError ? "not_found"
    : error instanceof e2b.TimeoutError ? "timeout"
    : fallback;
  const message = error instanceof Error ? error.message : String(error);
  return new EnvironmentProviderError(code, `e2b: ${message}`, { provider: "e2b", cause: error, secrets });
}

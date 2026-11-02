import { randomBytes, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { Daytona, type Sandbox } from "@daytonaio/sdk";
import {
  BOX_PINS,
  BRIDGE_RUN_TAG,
  createBridgeSandboxProvider,
  type BridgeSandbox,
  type BridgeSandboxProviderOptions,
  type BridgeSandboxVendor,
} from "@tangle-network/agent-provider-cli-bridge/sandbox";
import {
  EnvironmentProviderError,
  environmentProviderErrorCodeForStatus,
  type AgentEnvironmentProvider,
  type AgentEnvironmentStatus,
  type ExecResult,
} from "@tangle-network/agent-interface/environment-provider";

/** The snapshot `pnpm build:sandbox-image --target daytona` publishes for the pinned box. */
export const DAYTONA_BOX_SNAPSHOT = `tangle-cli-bridge-box-${BOX_PINS.cliBridgeCommit.slice(0, 12)}`;

export interface DaytonaProviderOptions extends Omit<BridgeSandboxProviderOptions, "vendor"> {
  /** Defaults to the SDK's own reading of `DAYTONA_API_KEY`. */
  apiKey?: string;
  apiUrl?: string;
  target?: string;
  /** Box snapshot used when `workspace.environment` names none. */
  snapshot?: string;
}

/** A provider whose environments are Daytona sandboxes running CLI Bridge from the box snapshot. */
export function createDaytonaProvider(options: DaytonaProviderOptions): AgentEnvironmentProvider {
  const { apiKey, apiUrl, target, snapshot, ...bridge } = options;
  return createBridgeSandboxProvider({ ...bridge, vendor: daytonaVendor({ apiKey, apiUrl, target, snapshot }) });
}

function daytonaVendor(config: Pick<DaytonaProviderOptions, "apiKey" | "apiUrl" | "target" | "snapshot">): BridgeSandboxVendor {
  let client: Daytona | undefined;
  // The SDK constructor throws without a credential, so refusals and capabilities never need one.
  const daytona = (): Daytona =>
    (client ??= new Daytona({
      ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
      ...(config.apiUrl === undefined ? {} : { apiUrl: config.apiUrl }),
      ...(config.target === undefined ? {} : { target: config.target }),
    }));
  return {
    name: "daytona",
    support: { environment: true, image: false, resources: false, egress: ["open", "strict", "blocked"] },
    async create(request) {
      request.signal?.throwIfAborted();
      const pending = vendorCall("create", () =>
        daytona().create(
          {
            snapshot: request.environment ?? config.snapshot ?? DAYTONA_BOX_SNAPSHOT,
            user: "node",
            ...(request.name === undefined ? {} : { name: request.name }),
            labels: request.metadata,
            envVars: request.env,
            public: false,
            ttlMinutes: Math.ceil(request.lifetimeMs / 60_000),
            autoStopInterval: 0,
            autoDeleteInterval: 0,
            ...(request.egress?.mode === "blocked" ? { networkBlockAll: true } : {}),
            ...(request.egress?.mode === "strict" ? { domainAllowList: request.egress.allowDomains.join(",") } : {}),
          },
          { timeout: 600 },
        ),
      );
      return daytonaSandbox(await abortable(pending, request.signal, (late) => late.delete(60, true)));
    },
    async connect(id) {
      try {
        return daytonaSandbox(await vendorCall("get", () => daytona().get(id)));
      } catch (error) {
        if (error instanceof EnvironmentProviderError && error.code === "not_found") return null;
        throw error;
      }
    },
    async list(query) {
      const out: Array<{ id: string; status: AgentEnvironmentStatus; name?: string; metadata: Record<string, string> }> = [];
      try {
        const listed = daytona().list({
          ...(query.metadata === undefined ? {} : { labels: query.metadata }),
          ...(query.name === undefined ? {} : { name: query.name }),
        });
        for await (const sandbox of listed) {
          if (sandbox.labels[BRIDGE_RUN_TAG] === undefined) continue;
          if (query.name !== undefined && sandbox.name !== query.name) continue;
          out.push({ id: sandbox.id, status: daytonaStatus(sandbox.state), name: sandbox.name, metadata: sandbox.labels });
        }
      } catch (error) {
        throw typedError("list", error);
      }
      return out;
    },
  };
}

function daytonaSandbox(sandbox: Sandbox): BridgeSandbox {
  const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
  const run = async (command: string): Promise<ExecResult> => {
    const result = await vendorCall("exec", () => sandbox.process.executeCommand(command, undefined, undefined, 60));
    return { exitCode: result.exitCode, stdout: result.result, stderr: "" };
  };
  const mustRun = async (command: string, what: string): Promise<void> => {
    const result = await run(command);
    if (result.exitCode !== 0) throw new EnvironmentProviderError("transport", `${what} failed (exit ${result.exitCode}): ${result.stdout.trim().slice(0, 300)}`, { provider: "daytona" });
  };
  return {
    id: sandbox.id,
    region: sandbox.target,
    async exec(command, options) {
      options?.signal?.throwIfAborted();
      // executeCommand returns one output field; a session command returns stdout and stderr apart.
      const session = `exec-${randomUUID()}`;
      const marker = randomBytes(6).toString("hex");
      const env = Object.entries(options?.env ?? {}).map(([key, value]) => `export ${key}=${quote(value)}; `).join("");
      const cwd = options?.cwd === undefined ? "" : `cd ${quote(options.cwd)} && `;
      await vendorCall("exec", () => sandbox.process.createSession(session));
      const ended = new AbortController();
      const timer = options?.timeoutMs === undefined ? undefined : setTimeout(() => ended.abort(new EnvironmentProviderError("timeout", `exec exceeded ${options.timeoutMs} ms`, { provider: "daytona" })), options.timeoutMs);
      const signal = options?.signal === undefined ? ended.signal : AbortSignal.any([options.signal, ended.signal]);
      try {
        const response = await abortable(
          vendorCall("exec", () => sandbox.process.executeSessionCommand(session, { command: `export TBOX_EXEC=${marker}; ${env}${cwd}${command}`, runAsync: false })),
          signal,
        );
        return { exitCode: response.exitCode ?? 1, stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
      } catch (error) {
        if (signal.aborted) {
          await run(`for p in /proc/[0-9]*; do grep -qz 'TBOX_EXEC=${marker}' "$p/environ" 2>/dev/null && kill -9 "\${p#/proc/}" 2>/dev/null; done; true`).catch(() => undefined);
        }
        throw error;
      } finally {
        clearTimeout(timer);
        await sandbox.process.deleteSession(session).catch(() => undefined);
      }
    },
    async spawn(command, options) {
      // The session API carries no per-command env, so the Bridge reads a 0600 file that it deletes before exec.
      const file = `/tmp/tbox-env-${randomBytes(8).toString("hex")}`;
      const lines = Object.entries(options.env).map(([key, value]) => `export ${key}=${quote(value)}`).join("\n");
      await mustRun(`umask 077 && : > ${file}`, "creating the Bridge env file");
      await vendorCall("spawn", () => sandbox.fs.uploadFile(Buffer.from(`${lines}\n`), file));
      const session = `bridge-${randomUUID()}`;
      await vendorCall("spawn", () => sandbox.process.createSession(session));
      const cwd = options.cwd === undefined ? "" : `cd ${quote(options.cwd)} && `;
      await vendorCall("spawn", () =>
        sandbox.process.executeSessionCommand(session, { command: `. ${file} && rm -f ${file} && ${cwd}exec ${command} >/tmp/bridge.log 2>&1`, runAsync: true }),
      );
    },
    async read(path, options) {
      options?.signal?.throwIfAborted();
      const content = await vendorCall("read", () => sandbox.fs.downloadFile(path));
      return content.toString("utf8");
    },
    async write(path, content, options) {
      options?.signal?.throwIfAborted();
      await mustRun(`mkdir -p ${quote(posix.dirname(path))}`, `creating the parent of ${path}`);
      await vendorCall("write", () => sandbox.fs.uploadFile(Buffer.from(content, "utf8"), path));
    },
    async endpoint(port) {
      const link = await vendorCall("endpoint", () => sandbox.getPreviewLink(port));
      return { url: link.url, headers: { "X-Daytona-Preview-Token": link.token } };
    },
    async status(options) {
      options?.signal?.throwIfAborted();
      try {
        await vendorCall("status", () => sandbox.refreshData());
        return daytonaStatus(sandbox.state);
      } catch (error) {
        if (error instanceof EnvironmentProviderError && error.code === "not_found") return "expired";
        throw error;
      }
    },
    async destroy() {
      try {
        await vendorCall("destroy", () => sandbox.delete(60, true));
      } catch (error) {
        if (!(error instanceof EnvironmentProviderError && error.code === "not_found")) throw error;
      }
    },
  };
}

/** The SDK takes no AbortSignal, so an abort settles the call at once and `late` receives a result that arrives afterwards. */
async function abortable<T>(pending: Promise<T>, signal: AbortSignal | undefined, late?: (value: T) => Promise<unknown>): Promise<T> {
  if (signal === undefined) return pending;
  signal.throwIfAborted();
  let onAbort = (): void => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (signal.aborted && late !== undefined) void pending.then(late).catch(() => undefined);
  }
}

async function vendorCall<T>(operation: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw typedError(operation, error);
  }
}

function typedError(operation: string, error: unknown): EnvironmentProviderError {
  if (error instanceof EnvironmentProviderError) return error;
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  const name = (error as { name?: unknown } | null)?.name;
  const code = typeof status === "number"
    ? environmentProviderErrorCodeForStatus(status)
    : name === "DaytonaNotFoundError" ? "not_found"
      : name === "DaytonaAuthenticationError" ? "auth_failed"
        : name === "DaytonaTimeoutError" ? "timeout"
          : operation === "create" ? "provision_failed" : "transport";
  const message = error instanceof Error ? error.message : String(error);
  return new EnvironmentProviderError(code, `daytona ${operation}: ${message}`, {
    provider: "daytona",
    cause: error,
    ...(typeof status === "number" ? { status } : {}),
  });
}

function daytonaStatus(state: string | undefined): AgentEnvironmentStatus {
  switch (state) {
    case "started": return "running";
    case "stopped":
    case "paused":
    case "archived": return "stopped";
    case "error":
    case "build_failed": return "failed";
    case "destroyed":
    case "destroying": return "expired";
    case "pending_build": return "pending";
    case "creating":
    case "restoring":
    case "starting":
    case "stopping":
    case "building_snapshot":
    case "pulling_snapshot":
    case "archiving":
    case "resizing":
    case "snapshotting":
    case "forking":
    case "pausing":
    case "resuming": return "provisioning";
    default: return "unknown";
  }
}

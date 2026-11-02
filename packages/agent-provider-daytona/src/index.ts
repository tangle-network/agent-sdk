import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { Daytona, type Sandbox } from "@daytonaio/sdk";

const CODE_TOOLBOX_LANGUAGE_LABEL = "code-toolbox-language";
import {
  BOX_TEMPLATE_NAME,
  BRIDGE_RUN_TAG,
  createBridgeSandboxProvider,
  envFileLaunch,
  markedExec,
  untilAborted,
  type BridgeSandbox,
  type BridgeSandboxProviderOptions,
  type BridgeSandboxVendor,
} from "@tangle-network/agent-provider-cli-bridge/sandbox";
import { shellQuote } from "@tangle-network/agent-core/node";
import {
  EnvironmentProviderError,
  environmentProviderErrorCodeForStatus,
  type AgentEnvironmentProvider,
  type AgentEnvironmentStatus,
  type ExecResult,
} from "@tangle-network/agent-interface/environment-provider";

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
      const pending = vendorCall("create", async () => {
        try {
          return await daytona().create(
          {
            snapshot: request.environment ?? config.snapshot ?? BOX_TEMPLATE_NAME,
            user: "node",
            ...(request.name === undefined ? {} : { name: request.name }),
            labels: { ...request.metadata },
            envVars: request.env,
            public: false,
            ttlMinutes: Math.ceil(request.lifetimeMs / 60_000),
            autoStopInterval: 0,
            autoDeleteInterval: 0,
            ...(request.egress?.mode === "blocked" ? { networkBlockAll: true } : {}),
            ...(request.egress?.mode === "strict" ? { domainAllowList: request.egress.allowDomains.join(",") } : {}),
          },
          { timeout: 600 },
          );
        } catch (error) {
          // A create that times out after the POST names the sandbox it leaves running.
          const leftover = (error as { sandboxId?: unknown }).sandboxId;
          if (typeof leftover === "string") await daytona().get(leftover).then((sandbox) => sandbox.delete(60, true)).catch(() => undefined);
          throw error;
        }
      });
      return daytonaSandbox(await untilAborted(pending, request.signal, (late) => late.delete(60, true)));
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
          // The SDK adds its own language label to every sandbox it creates.
          const { [CODE_TOOLBOX_LANGUAGE_LABEL]: _language, ...metadata } = sandbox.labels;
          out.push({ id: sandbox.id, status: daytonaStatus(sandbox.state), name: sandbox.name, metadata });
        }
      } catch (error) {
        throw typedError("list", error);
      }
      return out;
    },
  };
}

function daytonaSandbox(sandbox: Sandbox): BridgeSandbox {
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
    // executeCommand returns one output field; a session command returns stdout and stderr apart.
    exec: (command, options) => markedExec(command, options, "daytona", async (script, signal) => {
      const session = `exec-${randomUUID()}`;
      try {
        await untilAborted(vendorCall("exec", () => sandbox.process.createSession(session)), signal);
        const response = await untilAborted(vendorCall("exec", () => sandbox.process.executeSessionCommand(session, { command: script, runAsync: false })), signal);
        return { exitCode: response.exitCode ?? 1, stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
      } finally {
        await sandbox.process.deleteSession(session).catch(() => undefined);
      }
    }),
    async spawn(command, options) {
      const launch = envFileLaunch(command, options);
      const session = `bridge-${randomUUID()}`;
      try {
        await mustRun(launch.prepare, "creating the Bridge env directory");
        await vendorCall("spawn", () => sandbox.fs.uploadFile(Buffer.from(launch.content), launch.file));
        await vendorCall("spawn", () => sandbox.process.createSession(session));
        await vendorCall("spawn", () => sandbox.process.executeSessionCommand(session, { command: launch.launch, runAsync: true }));
      } catch (error) {
        await run(launch.cleanup).catch(() => undefined);
        throw error;
      }
    },
    async read(path, options) {
      const content = await untilAborted(vendorCall("read", () => sandbox.fs.downloadFile(path)), options?.signal);
      return content.toString("utf8");
    },
    async write(path, content, options) {
      await untilAborted(mustRun(`mkdir -p ${shellQuote(posix.dirname(path))}`, `creating the parent of ${path}`), options?.signal);
      await untilAborted(vendorCall("write", () => sandbox.fs.uploadFile(Buffer.from(content, "utf8"), path)), options?.signal);
    },
    async endpoint(port) {
      const link = await vendorCall("endpoint", () => sandbox.getPreviewLink(port));
      return { url: link.url, headers: { "X-Daytona-Preview-Token": link.token } };
    },
    async status(options) {
      try {
        await untilAborted(vendorCall("status", () => sandbox.refreshData()), options?.signal);
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
  // 410 is Daytona's answer for a sandbox that existed and is permanently gone.
  const code = status === 410 ? "not_found" : typeof status === "number"
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

const STATUS_BY_STATE: Readonly<Record<string, AgentEnvironmentStatus>> = {
  started: "running", stopped: "stopped", paused: "stopped", archived: "stopped", error: "failed", build_failed: "failed",
  destroyed: "expired", destroying: "expired", pending_build: "pending",
};
const TRANSITION_STATES = new Set(["creating", "restoring", "starting", "stopping", "building_snapshot", "pulling_snapshot", "archiving", "resizing", "snapshotting", "forking", "pausing", "resuming"]);

function daytonaStatus(state: string | undefined): AgentEnvironmentStatus {
  if (state === undefined) return "unknown";
  return STATUS_BY_STATE[state] ?? (TRANSITION_STATES.has(state) ? "provisioning" : "unknown");
}

import { posix } from "node:path";
import { BoatApi, Configuration, SandboxStateEnum } from "@boatdev/sdk";
import { shellQuote } from "@tangle-network/agent-core/node";
import {
  EnvironmentProviderError,
  environmentProviderErrorCodeForStatus,
  type AgentEnvironmentProvider,
  type AgentEnvironmentStatus,
  type ExecResult,
} from "@tangle-network/agent-interface/environment-provider";
import {
  BOX_HARNESSES,
  BOX_PINS,
  BRIDGE_PORT,
  BRIDGE_RUN_TAG,
  checkpointSnapshotName,
  createBridgeSandboxProvider,
  envFileLaunch,
  markedExec,
  untilAborted,
  boxHarnessVersion,
  type BridgeSandbox,
  type BridgeSandboxProviderOptions,
  type BridgeSandboxVendor,
} from "@tangle-network/agent-provider-cli-bridge/sandbox";
import type { CommandRecord, Sandbox } from "@boatdev/sdk";

export interface BoatProviderOptions extends Omit<BridgeSandboxProviderOptions, "vendor"> {
  /** Defaults to the SDK's reading of `BOAT_API_KEY`. */
  apiKey?: string;
  /** Defaults to the SDK's reading of `BOAT_BASE_URL`. */
  baseUrl?: string;
  /** Boat snapshot name or sandbox id a fresh create boots; absent boots the stock image and installs the Bridge at create. */
  from?: string;
}

/**
 * An `AgentEnvironmentProvider` whose environments are Boat sandboxes running
 * CLI Bridge. Boat exposes no custom images, so a fresh create installs the
 * pinned Bridge and harnesses through Boat's `setupScript`; booting a prepared
 * snapshot (`from`, or `workspace.environment`) skips that install.
 */
export function createBoatProvider(options: BoatProviderOptions): AgentEnvironmentProvider {
  const { apiKey, baseUrl, from, ...bridge } = options;
  return createBridgeSandboxProvider({ ...bridge, vendor: boatVendor({ apiKey, baseUrl, from }) });
}

/** The `setupScript` that turns Boat's stock image into a box: the exact pins the box image installs. */
export function boatBridgeSetupScript(): string {
  const bridge = `https://github.com/${BOX_PINS.cliBridgeRepository}/archive/${BOX_PINS.cliBridgeCommit}.tar.gz`;
  const packages = Object.values(BOX_HARNESSES).map((entry) => `${entry.npmPackage}@${boxHarnessVersion(entry.harness)}`);
  if (packages.length === 0) throw new Error("the box harness table is empty; nothing to install");
  return `npm install -g ${[...packages, bridge].join(" ")} && command -v cli-bridge`;
}

function boatVendor(config: Pick<BoatProviderOptions, "apiKey" | "baseUrl" | "from">): BridgeSandboxVendor {
  let client: BoatApi | undefined;
  // The SDK constructor throws without a credential, so refusals never need one.
  const boat = (): BoatApi =>
    (client ??= new BoatApi(new Configuration({
      ...(config.apiKey === undefined ? {} : { accessToken: config.apiKey }),
      ...(config.baseUrl === undefined ? {} : { basePath: config.baseUrl }),
    })));
  return {
    name: "boat",
    support: { environment: true, image: false, resources: false, egress: [] },
    // A named Boat snapshot restores through `create({ from })`.
    snapshots: {
      async create(sandboxId, options) {
        options?.signal?.throwIfAborted();
        const name = checkpointSnapshotName(options?.name);
        await vendorCall("snapshot", () => boat().saveNamedSnapshot({ sandboxId, name }));
        return { id: name };
      },
    },
    async create(request) {
      request.signal?.throwIfAborted();
      const from = request.snapshot ?? request.environment ?? config.from;
      const created = await vendorCall("create", () => boat().create({
        ttlSeconds: Math.ceil(request.lifetimeMs / 1000),
        ...(request.name === undefined ? {} : { name: request.name }),
        labels: { ...request.metadata, [BRIDGE_RUN_TAG]: request.metadata[BRIDGE_RUN_TAG]! },
        env: request.env,
        // A fresh boot must become a box before the Bridge can run; a prepared snapshot already is one.
        ...(from === undefined ? { setupScript: boatBridgeSetupScript(), failFast: true } : { from }),
        hostedPorts: [{ port: BRIDGE_PORT, _public: true }],
      }));
      return boatSandbox(boat(), created.sandbox.id, created.hostedPorts?.find((port) => port.port === BRIDGE_PORT), await untilAborted(
        waitForState(boat(), created.sandbox.id, request.signal),
        request.signal,
        (late) => boat().deleteSandbox({ xAsciiConfirmDelete: late.id, sandboxId: late.id }).catch(() => undefined),
      ));
    },
    async connect(id, options) {
      try {
        return boatSandbox(boat(), id, undefined, await untilAborted(waitForState(boat(), id, options?.signal, true), options?.signal));
      } catch (error) {
        if (error instanceof EnvironmentProviderError && error.code === "not_found") return null;
        throw error;
      }
    },
    async list(query, options) {
      const listed = await untilAborted(vendorCall("list", () => boat().sandboxes()), options?.signal);
      return listed.sandboxes
        .filter((sandbox) => sandbox.labels?.[BRIDGE_RUN_TAG] !== undefined)
        .filter((sandbox) => query.name === undefined || sandbox.name === query.name)
        .filter((sandbox) => Object.entries(query.metadata ?? {}).every(([key, value]) => sandbox.labels?.[key] === value))
        .map((sandbox) => ({ id: sandbox.id, status: boatStatus(sandbox.state), name: sandbox.name, metadata: sandbox.labels ?? {} }));
    },
  };
}

function boatSandbox(boat: BoatApi, id: string, hostedPort: { url?: string; isProtected?: boolean; access?: string } | undefined, ready: Promise<Sandbox> | Sandbox): BridgeSandbox {
  const settle = () => Promise.resolve(ready).catch(() => undefined);
  const commandLogs = async (commandId: string, stream: "stdout" | "stderr"): Promise<string> => {
    let offset = 0;
    let data = "";
    for (;;) {
      const page = await vendorCall("exec", () => boat.commandLogs({ sandboxId: id, commandId, stream, offset }));
      data += page.data ?? "";
      if (page.done || page.nextOffset === undefined || page.nextOffset <= offset) return data;
      offset = page.nextOffset;
    }
  };
  return {
    id,
    exec: (command, options) => markedExec(command, options, "boat", async (script, signal) => {
      await settle();
      const started = await untilAborted(vendorCall("exec", () => boat.command({ sandboxId: id, command: script, timeoutSeconds: 24 * 60 * 60 })), signal);
      if (started.commandId === undefined) throw new EnvironmentProviderError("transport", "Boat returned no command id", { provider: "boat" });
      for (;;) {
        signal?.throwIfAborted();
        const record: CommandRecord = (await vendorCall("exec", () => boat.getCommand({ sandboxId: id, commandId: started.commandId! }))).command;
        if (record.status === "running") {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        const [stdout, stderr] = await Promise.all([
          commandLogs(started.commandId!, "stdout"),
          commandLogs(started.commandId!, "stderr"),
        ]);
        return { exitCode: record.exitCode ?? 1, stdout, stderr };
      }
    }),
    async spawn(command, options) {
      await settle();
      const launch = envFileLaunch(command, options);
      const write = await this.exec(`mkdir -p ${shellQuote(posix.dirname(launch.file))} && base64 -d > ${shellQuote(launch.file)} <<'TANGLE_EOF'\n${Buffer.from(launch.content, "utf8").toString("base64")}\nTANGLE_EOF`);
      if (write.exitCode !== 0) throw new EnvironmentProviderError("transport", `writing the Bridge env file failed (exit ${write.exitCode})`, { provider: "boat" });
      const started = await vendorCall("spawn", () => boat.command({ sandboxId: id, command: launch.launch, cwd: options.cwd, detached: true }));
      if (started.success === false) throw new EnvironmentProviderError("transport", "Boat refused the detached Bridge process", { provider: "boat" });
    },
    async read(path, options) {
      await settle();
      const file = await untilAborted(vendorCall("read", () => boat.readFile({ sandboxId: id, path })), options?.signal);
      return file.encoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
    },
    async write(path, content, options) {
      const result = await this.exec(`mkdir -p ${shellQuote(posix.dirname(path))} && base64 -d > ${shellQuote(path)} <<'TANGLE_EOF'\n${Buffer.from(content, "utf8").toString("base64")}\nTANGLE_EOF`, { ...(options?.signal === undefined ? {} : { signal: options.signal }) });
      if (result.exitCode !== 0) throw new EnvironmentProviderError("transport", `writing ${path} failed (exit ${result.exitCode})`, { provider: "boat" });
    },
    async endpoint() {
      await settle();
      if (hostedPort !== undefined) return endpointOf(hostedPort);
      return endpointOf(await vendorCall("endpoint", () => boat.hostPort({ sandboxId: id, hostPortRequest: { port: BRIDGE_PORT, _public: true } })));
    },
    async status(options) {
      try {
        await settle();
        const sandbox = await untilAborted(vendorCall("status", () => boat.get({ sandboxId: id })), options?.signal);
        return boatStatus(sandbox.sandbox.state);
      } catch (error) {
        if (error instanceof EnvironmentProviderError && error.code === "not_found") return "expired";
        throw error;
      }
    },
    async destroy() {
      try {
        await settle();
        await vendorCall("destroy", () => boat.deleteSandbox({ xAsciiConfirmDelete: id, sandboxId: id }));
      } catch (error) {
        if (!(error instanceof EnvironmentProviderError && error.code === "not_found")) throw error;
      }
    },
  };
}

function endpointOf(port: { url?: string; isProtected?: boolean; access?: string }): { url: string; headers?: Record<string, string> } {
  if (port.url === undefined || port.url.length === 0) {
    throw new EnvironmentProviderError("provision_failed", "Boat hosted no URL for the Bridge port", { provider: "boat" });
  }
  // A protected hosted port answers one bearer token; the live run confirms the scheme Boat enforces.
  return { url: port.url, ...(port.isProtected && port.access ? { headers: { Authorization: `Bearer ${port.access}` } } : {}) };
}

async function waitForState(boat: BoatApi, id: string, signal: AbortSignal | undefined, connectOnly = false): Promise<Sandbox> {
  for (;;) {
    signal?.throwIfAborted();
    const { sandbox } = await vendorCall("create", () => boat.get({ sandboxId: id }));
    if (sandbox.state === SandboxStateEnum.Error || sandbox.state === SandboxStateEnum.Cancelled) {
      throw new EnvironmentProviderError("provision_failed", `Boat sandbox ${id} reached ${sandbox.state}${sandbox.error ? `: ${sandbox.error}` : ""}`, { provider: "boat" });
    }
    if (sandbox.state === SandboxStateEnum.Ready || sandbox.state === SandboxStateEnum.Idle || sandbox.state === SandboxStateEnum.Running) return sandbox;
    if (connectOnly && sandbox.state === SandboxStateEnum.Archived) {
      throw new EnvironmentProviderError("not_found", `Boat sandbox ${id} is archived`, { provider: "boat" });
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

const STATUS_BY_STATE: Readonly<Record<string, AgentEnvironmentStatus>> = {
  [SandboxStateEnum.Ready]: "running",
  [SandboxStateEnum.Idle]: "running",
  [SandboxStateEnum.Running]: "running",
  [SandboxStateEnum.Archived]: "stopped",
  [SandboxStateEnum.Error]: "failed",
  [SandboxStateEnum.Cancelled]: "failed",
};

const TRANSITION_STATES = new Set<string>([SandboxStateEnum.Init, SandboxStateEnum.Provisioning, SandboxStateEnum.Provisioned, SandboxStateEnum.Cloning, SandboxStateEnum.Archiving]);

function boatStatus(state: string | undefined): AgentEnvironmentStatus {
  if (state === undefined) return "unknown";
  return STATUS_BY_STATE[state] ?? (TRANSITION_STATES.has(state as SandboxStateEnum) ? "provisioning" : "unknown");
}

async function vendorCall<T>(operation: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof EnvironmentProviderError) throw error;
    const status = (error as { status?: unknown } | null)?.status ?? (error as { statusCode?: unknown } | null)?.statusCode;
    const code = typeof status === "number" ? environmentProviderErrorCodeForStatus(status) : "transport";
    throw new EnvironmentProviderError(code, error instanceof Error ? error.message : String(error), { cause: error, provider: "boat" });
  }
}

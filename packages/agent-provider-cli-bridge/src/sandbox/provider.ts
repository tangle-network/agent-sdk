import { randomBytes, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import {
  canonicalAgentProfileDigest,
  TANGLE_ROUTER_DEFAULT_ROOT_URL,
  type AgentProfile,
  type HarnessType,
} from "@tangle-network/agent-interface";
import {
  AgentEnvironmentGetOptionsSchema,
  AgentTurnInputSchema,
  EnvironmentProviderError,
  type AgentEnvironment,
  type AgentEnvironmentCapabilities,
  type AgentEnvironmentEvent,
  type AgentEnvironmentProvider,
  type AgentEnvironmentStatus,
  type AgentTurnInput,
  type CreateAgentEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";
import { harnessModelSupportFor } from "@tangle-network/cli-agent-registry";
import { createCliBridgeProvider, defaultCliBridgeCapabilities } from "../index.js";
import { plannerLowers } from "./refusal.js";
import {
  BOX_WORKSPACE_DIR,
  BRIDGE_PORT,
  BRIDGE_START_COMMAND,
  bridgeProcessEnv,
  boxHarness,
  boxHarnessVersion,
} from "./box.js";
import { assertProfileValid, declarableHarnesses, refuseUnsupportedCreateInput, resolveBoxHarness, validateBoxProfile } from "./refusal.js";
import type { BridgeSandbox, BridgeSandboxVendor } from "./vendor.js";

export const BRIDGE_RUN_TAG = "tangle-bridge-run";
const DEFAULT_LIFETIME_MS = 2 * 60 * 60 * 1000;
const DEFAULT_READY_TIMEOUT_MS = 120_000;

export interface BridgeSandboxProviderOptions {
  vendor: BridgeSandboxVendor;
  /** The Router that serves the model, with the per-run capped key. The key reaches the Bridge process only. */
  router: { key: string | (() => string | Promise<string>); baseUrl?: string };
  /** Harnesses this provider accepts. Defaults to every harness in the box table. */
  harnesses?: readonly HarnessType[];
  /** Finite sandbox lifetime the vendor enforces. Must exceed the longest turn plus capture. */
  lifetimeMs?: number;
  readyTimeoutMs?: number;
}

const UNSUPPORTED_TURN_FIELDS = [
  "contextTransfer",
  "nativeContinuation",
  "nativeResume",
  "interactions",
  "controlRef",
  "lastEventId",
] as const;

/**
 * An {@link AgentEnvironmentProvider} for a vendor cloud: each environment is a
 * vendor sandbox created from the box image, running CLI Bridge, and every turn
 * is delegated to {@link createCliBridgeProvider} at the sandbox's exposed URL.
 */
export function createBridgeSandboxProvider(options: BridgeSandboxProviderOptions): AgentEnvironmentProvider {
  const { vendor } = options;
  const declared = options.harnesses ?? declarableHarnesses();
  const supported = new Set(declarableHarnesses());
  for (const harness of declared) {
    if (!supported.has(harness)) throw new Error(`harness ${harness} is not in the box harness table`);
  }
  const routerBaseUrl = (options.router.baseUrl ?? TANGLE_ROUTER_DEFAULT_ROOT_URL).replace(/\/+$/, "");
  const lifetimeMs = options.lifetimeMs ?? DEFAULT_LIFETIME_MS;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  const providerCapabilities = (harness?: HarnessType): AgentEnvironmentCapabilities =>
    environmentCapabilities(defaultCliBridgeCapabilities(harness), vendor, harness === undefined ? false : plannerLowers(harness, "hooks"));

  async function create(input: CreateAgentEnvironmentInput): Promise<AgentEnvironment> {
    input.signal?.throwIfAborted();
    refuseUnsupportedCreateInput(input, vendor.support);
    const profile = input.profile as AgentProfile;
    const validation = validateBoxProfile(profile, input.backend, declared);
    assertProfileValid(validation);
    const harness = resolveBoxHarness(profile, input.backend, declared);
    const box = boxHarness(harness)!;
    const runTag = randomUUID();
    const bearer = randomBytes(32).toString("hex");
    const routerKey = typeof options.router.key === "function" ? await options.router.key() : options.router.key;
    const secrets = [bearer, routerKey];
    const workspaceDir = repositoryCwd(input);
    let sandbox: BridgeSandbox | undefined;
    let dispatcher: Agent | undefined;
    try {
      sandbox = await vendor.create({
        ...(input.name === undefined ? {} : { name: input.name }),
        metadata: { ...stringMetadata(input.metadata), [BRIDGE_RUN_TAG]: runTag },
        env: input.env ?? {},
        lifetimeMs,
        ...(input.workspace?.environment === undefined ? {} : { environment: input.workspace.environment }),
        ...(input.workspace?.image === undefined ? {} : { image: input.workspace.image }),
        ...(input.resources === undefined ? {} : { resources: input.resources }),
        ...(input.egress === undefined ? {} : { egress: egressFor(input, routerBaseUrl) }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      input.signal?.throwIfAborted();
      await sandbox.spawn(BRIDGE_START_COMMAND, {
        cwd: BOX_WORKSPACE_DIR,
        env: bridgeProcessEnv(box, bearer, { baseUrl: routerBaseUrl, key: routerKey }),
      });
      const endpoint = await sandbox.endpoint(BRIDGE_PORT, signalOption(input.signal));
      dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
      const bridgeFetch = vendorFetch(endpoint.headers ?? {}, dispatcher);
      await waitForBridge(endpoint.url, bearer, bridgeFetch, box.bridgeBackend, readyTimeoutMs, input.signal, secrets);
      await assertHarnessVersion(sandbox, harness, input.signal);
      await cloneRepository(sandbox, input, secrets);
      await ensureDirectory(sandbox, workspaceDir);
      const bridge = createCliBridgeProvider({
        baseUrl: endpoint.url,
        bearerToken: bearer,
        fetch: bridgeFetch,
        name: vendor.name,
      });
      const { workspace: _workspace, egress: _egress, resources: _resources, ...forwarded } = input;
      const inner = await bridge.create({
        ...forwarded,
        backend: harness,
        requestedId: sandbox.id,
        workspace: { cwd: { base: "host", path: workspaceDir } },
      });
      input.signal?.throwIfAborted();
      return wrapEnvironment({ inner, sandbox, vendor, harness, profile, workspaceDir, dispatcher, capabilities: environmentCapabilities(inner.capabilities ?? providerCapabilities(harness), vendor, plannerLowers(harness, "hooks")), input });
    } catch (error) {
      await dispatcher?.close().catch(() => undefined);
      throw await failAfterProvision(error, sandbox, vendor.name, secrets);
    }
  }

  return {
    name: vendor.name,
    capabilities: () => providerCapabilities(declared.length === 1 ? declared[0] : undefined),
    validateProfile(ref) {
      if (typeof ref === "string") {
        return { ok: false, issues: [{ level: "error", code: "named_profile_refused", path: "profile", message: `named profile ${ref} is unsupported; pass an inline AgentProfile` }] };
      }
      return validateBoxProfile(ref, undefined, declared);
    },
    create,
    async get(id, getOptions) {
      assertGetOptionsSupported(getOptions);
      AgentEnvironmentGetOptionsSchema.parse(getOptions ?? {});
      getOptions?.signal?.throwIfAborted();
      const sandbox = await vendor.connect(id, signalOption(getOptions?.signal));
      if (sandbox === null) return null;
      if (sandbox.id !== id) {
        throw new EnvironmentProviderError("transport", `vendor returned sandbox ${sandbox.id} for ${id}`, { provider: vendor.name });
      }
      return reconstructedEnvironment(sandbox, vendor, providerCapabilities());
    },
    async list(query, listOptions) {
      const summaries = await vendor.list(
        {
          ...(query?.name === undefined ? {} : { name: query.name }),
          ...(query?.metadata === undefined ? {} : { metadata: stringMetadata(query.metadata) }),
        },
        signalOption(listOptions?.signal),
      );
      return summaries.map((summary) => ({
        id: summary.id,
        provider: vendor.name,
        status: summary.status,
        ...(summary.name === undefined ? {} : { name: summary.name }),
        metadata: summary.metadata,
      }));
    },
  };
}

function signalOption(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

function stringMetadata(metadata: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (typeof value !== "string") {
      throw new EnvironmentProviderError("refused", `vendor tags hold string values; ${key} is not a string`, { path: `metadata.${key}` });
    }
    out[key] = value;
  }
  return out;
}

function repositoryCwd(input: CreateAgentEnvironmentInput): string {
  const cwd = input.workspace?.cwd;
  return cwd === undefined || cwd.path === "." ? BOX_WORKSPACE_DIR : posix.join(BOX_WORKSPACE_DIR, cwd.path);
}

function egressFor(input: CreateAgentEnvironmentInput, routerBaseUrl: string) {
  const policy = input.egress!;
  const routerHost = new URL(routerBaseUrl).host;
  const allowed = policy.mode === "strict"
    ? (policy.allowDomains ?? []).map((entry) => (typeof entry === "string" ? entry : entry.domain))
    : [];
  return { mode: policy.mode, allowDomains: policy.mode === "strict" ? [...new Set([...allowed, routerHost])] : allowed };
}

/** Requests to the Bridge carry the vendor gateway's headers and no timeouts, because a turn streams for minutes. */
function vendorFetch(headers: Record<string, string>, dispatcher: Agent): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    undiciFetch(input as string, {
      ...(init as object),
      headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
      dispatcher,
    })) as unknown as typeof fetch;
}

async function waitForBridge(
  baseUrl: string,
  bearer: string,
  bridgeFetch: typeof fetch,
  backend: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  secrets: readonly string[],
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const response = await bridgeFetch(`${baseUrl.replace(/\/+$/, "")}/health`, {
        headers: { authorization: `Bearer ${bearer}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        const health = (await response.json()) as { backends?: Array<{ name?: string; state?: string }> };
        const state = health.backends?.find((entry) => entry.name !== undefined && (entry.name === backend || entry.name.startsWith(backend)))?.state;
        if (state === "ready") return;
        if (state !== undefined && state !== "probing") {
          throw new EnvironmentProviderError("materialization_failed", `cli-bridge reports the ${backend} backend ${state}`, { secrets });
        }
        last = `backend ${state ?? "absent"}`;
      } else {
        last = `health status ${response.status}`;
        if (response.status === 401 || response.status === 403) {
          throw new EnvironmentProviderError("auth_failed", `cli-bridge health answered ${response.status}`, { status: response.status, secrets });
        }
      }
    } catch (error) {
      if (error instanceof EnvironmentProviderError || signal?.aborted) throw error;
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new EnvironmentProviderError("provision_failed", `cli-bridge was not ready within ${timeoutMs} ms (${last})`, { secrets });
}

async function assertHarnessVersion(sandbox: BridgeSandbox, harness: HarnessType, signal: AbortSignal | undefined): Promise<void> {
  const box = boxHarness(harness)!;
  const pinned = boxHarnessVersion(harness);
  const result = await sandbox.exec(`${box.bin} --version`, { ...signalOption(signal), timeoutMs: 30_000 });
  if (result.exitCode !== 0 || result.stdout.trim().split(/\s+/)[0] !== pinned) {
    throw new EnvironmentProviderError("materialization_failed", `${box.bin} --version reported "${result.stdout.trim() || result.stderr.trim()}" (exit ${result.exitCode}); the registry pins ${pinned}`);
  }
}

async function cloneRepository(sandbox: BridgeSandbox, input: CreateAgentEnvironmentInput, secrets: readonly string[]): Promise<void> {
  const repoUrl = input.workspace?.repoUrl;
  if (repoUrl === undefined) return;
  const gitRef = input.workspace?.gitRef;
  const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
  const command = [
    `rm -rf ${quote(BOX_WORKSPACE_DIR)}/.git`,
    `git clone ${quote(repoUrl)} ${quote(BOX_WORKSPACE_DIR)}.clone`,
    ...(gitRef === undefined ? [] : [`git -C ${quote(BOX_WORKSPACE_DIR)}.clone checkout ${quote(gitRef)}`]),
    `cp -a ${quote(BOX_WORKSPACE_DIR)}.clone/. ${quote(BOX_WORKSPACE_DIR)}/ && rm -rf ${quote(BOX_WORKSPACE_DIR)}.clone`,
  ].join(" && ");
  const result = await sandbox.exec(command, { timeoutMs: 600_000, ...signalOption(input.signal) });
  if (result.exitCode !== 0) {
    throw new EnvironmentProviderError("provision_failed", `cloning ${repoUrl} failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 400)}`, { path: "workspace.repoUrl", secrets });
  }
}

async function ensureDirectory(sandbox: BridgeSandbox, directory: string): Promise<void> {
  const result = await sandbox.exec(`mkdir -p '${directory.replace(/'/g, `'\\''`)}'`, { timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    throw new EnvironmentProviderError("provision_failed", `cannot create workspace directory ${directory}: ${result.stderr.trim().slice(0, 200)}`, { path: "workspace.cwd" });
  }
}

/** Destroy the sandbox a failed create left behind; a destroy that fails names the sandbox as a cleanup handle. */
async function failAfterProvision(
  error: unknown,
  sandbox: BridgeSandbox | undefined,
  provider: string,
  secrets: readonly string[],
): Promise<unknown> {
  const original = error instanceof EnvironmentProviderError || isAbort(error) ? error : new EnvironmentProviderError(
    "provision_failed",
    error instanceof Error ? error.message : String(error),
    { cause: error, provider, secrets },
  );
  if (sandbox === undefined) return original;
  try {
    await sandbox.destroy();
    return original;
  } catch (cleanup) {
    return new EnvironmentProviderError(
      "cleanup_failed",
      `create failed (${original instanceof Error ? original.message : String(original)}) and sandbox ${sandbox.id} could not be destroyed`,
      { cause: new AggregateError([original, cleanup]), provider, secrets, cleanupHandle: { environmentId: sandbox.id, provider } },
    );
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function assertGetOptionsSupported(options: unknown): void {
  if (options === undefined || options === null) return;
  for (const key of ["readOnly", "proxySecrets", "proxySecretParents", "expectedProxySecretGeneration", "requireInPlace", "contextTransfer"]) {
    if (key in (options as object)) {
      throw new EnvironmentProviderError("refused", `get does not honor ${key}`, { path: key });
    }
  }
}

/** The document for one environment: what the Bridge claims, plus the vendor sandbox's workspace and placement. */
function environmentCapabilities(bridge: AgentEnvironmentCapabilities, vendor: BridgeSandboxVendor, hooks?: boolean): AgentEnvironmentCapabilities {
  const {
    retainedControl: _retained,
    nativeContinuation: _native,
    contextTransfer: _transfer,
    interactions: _interactions,
    observation: _observation,
    ...base
  } = bridge;
  return {
    ...base,
    profile: { ...base.profile, validation: true, hooks: hooks === true },
    workspace: { read: true, write: true, exec: true, git: false, upload: false, download: false, cwdBases: { repository: true, host: false } },
    placement: true,
    create: {
      durableIdempotency: false,
      ...(vendor.support.egress.length === 0 ? {} : { egress: [...vendor.support.egress] }),
    },
  };
}

interface WrapArgs {
  inner: AgentEnvironment;
  sandbox: BridgeSandbox;
  vendor: BridgeSandboxVendor;
  harness: HarnessType;
  profile: AgentProfile;
  workspaceDir: string;
  dispatcher: Agent;
  capabilities: AgentEnvironmentCapabilities;
  input: CreateAgentEnvironmentInput;
}

function sandboxOperations(sandbox: BridgeSandbox, vendor: BridgeSandboxVendor, workspaceDir: string) {
  const resolve = (path: string): string => (path.startsWith("/") ? path : posix.join(workspaceDir, path));
  return {
    read: (path: string, options?: { signal?: AbortSignal }) => sandbox.read(resolve(path), options),
    write: (path: string, content: string, options?: { signal?: AbortSignal }) => sandbox.write(resolve(path), content, options),
    exec: (command: string, options?: Parameters<BridgeSandbox["exec"]>[1]) =>
      sandbox.exec(command, { ...options, cwd: options?.cwd === undefined ? workspaceDir : resolve(options.cwd) }),
    placement: async () => ({
      kind: "provider" as const,
      sandboxId: sandbox.id,
      ...(sandbox.region === undefined ? {} : { region: sandbox.region }),
      providerMetadata: { vendor: vendor.name },
    }),
    async status(options?: { signal?: AbortSignal }): Promise<AgentEnvironmentStatus> {
      return sandbox.status(options);
    },
  };
}

function wrapEnvironment(args: WrapArgs): AgentEnvironment {
  const { inner, sandbox, vendor, workspaceDir } = args;
  const operations = sandboxOperations(sandbox, vendor, workspaceDir);
  const createDigest = canonicalAgentProfileDigest(args.profile);
  let busy = false;
  let destroyPromise: Promise<void> | undefined;

  const guard = (turn: AgentTurnInput): AgentTurnInput => {
    const result = AgentTurnInputSchema.safeParse(turn);
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new EnvironmentProviderError("invalid_input", issue?.message ?? "invalid turn input", { path: `turn.${(issue?.path ?? []).join(".")}`.replace(/\.$/, ""), cause: result.error });
    }
    const parsed = result.data;
    for (const field of UNSUPPORTED_TURN_FIELDS) {
      if (parsed[field] !== undefined) {
        throw new EnvironmentProviderError("refused", `this environment does not honor turn.${field}`, { path: `turn.${field}` });
      }
    }
    const turnProfile = parsed.profile ?? (parsed.providerOptions?.backend as { profile?: AgentProfile } | undefined)?.profile;
    if (turnProfile !== undefined && canonicalAgentProfileDigest(turnProfile) !== createDigest) {
      throw new EnvironmentProviderError("refused", "a turn profile that differs from the create profile is refused, never run under the old profile", { path: "turn.profile" });
    }
    if (parsed.model !== undefined) {
      const support = harnessModelSupportFor(args.harness, parsed.model);
      if (!support.supported) throw new EnvironmentProviderError("refused", support.message, { path: "turn.model" });
    }
    return turn;
  };

  const exclusive = async function* (turn: AgentTurnInput): AsyncIterable<AgentEnvironmentEvent> {
    const checked = guard(turn);
    if (checked.detach === true) {
      throw new EnvironmentProviderError("refused", "stream does not honor detach; use dispatch", { path: "turn.detach" });
    }
    if (busy) throw new EnvironmentProviderError("conflict", "a turn is already running on this environment", { provider: vendor.name });
    busy = true;
    try {
      yield* projectTurn(inner, checked, checked.model ?? args.profile.model?.default);
    } catch (error) {
      // An aborted turn rejects with AbortError whatever the Bridge says about confirming the cancel; the Bridge's error stays as the cause.
      if (checked.signal?.aborted === true && !isAbort(error)) {
        throw new DOMException("turn aborted", { name: "AbortError", cause: error } as never);
      }
      throw error;
    } finally {
      busy = false;
    }
  };

  return {
    id: sandbox.id,
    provider: vendor.name,
    creation: "created",
    ...(inner.name === undefined ? {} : { name: inner.name }),
    capabilities: args.capabilities,
    status: operations.status,
    stream: exclusive,
    ...(inner.session === undefined ? {} : { session: (id: string, options?: Parameters<NonNullable<AgentEnvironment["session"]>>[1]) => inner.session!(id, options) }),
    ...(inner.dispatch === undefined
      ? {}
      : {
          async dispatch(turn: AgentTurnInput) {
            const checked = guard(turn);
            if (busy) throw new EnvironmentProviderError("conflict", "a turn is already running on this environment", { provider: vendor.name });
            return inner.dispatch!(checked);
          },
        }),
    read: operations.read,
    write: operations.write,
    exec: operations.exec,
    placement: operations.placement,
    destroy(options) {
      destroyPromise ??= (async () => {
        try {
          await inner.destroy?.(options).catch(() => undefined);
        } finally {
          await sandbox.destroy(options);
          await args.dispatcher.close().catch(() => undefined);
        }
      })().catch((error) => {
        destroyPromise = undefined;
        throw error;
      });
      return destroyPromise;
    },
  };
}

const isTerminalResult = (event: AgentEnvironmentEvent): boolean => event.type === "result";

/** The Bridge's own dollar figure is the harness's catalog estimate, never a receipt, so no event carries it. */
function withoutHarnessCost(event: AgentEnvironmentEvent): AgentEnvironmentEvent {
  if (event.usage?.cost === undefined) return event;
  const { cost: _cost, ...usage } = event.usage;
  return { ...event, usage };
}

/** The model the harness reported serving, read from the Bridge's terminal frame. */
function reportedModel(event: AgentEnvironmentEvent): string | undefined {
  const models = event.data.provider_models;
  const reported = event.data.provider_model ?? (Array.isArray(models) ? models[0] : undefined);
  return typeof reported === "string" ? reported : undefined;
}

/**
 * One turn as the contract states it: an `execution.started` event naming the
 * declared model, the Bridge's events without harness dollar estimates, a
 * terminal `result` that names the model the harness reported serving, and
 * `turn.timeoutMs` ending the run (the Bridge cancels it, and a failed terminal
 * event names the timeout and carries the usage observed so far).
 */
async function* projectTurn(inner: AgentEnvironment, turn: AgentTurnInput, declaredModel: string | undefined): AsyncIterable<AgentEnvironmentEvent> {
  const { timeoutMs, ...rest } = turn;
  yield {
    type: "execution.started",
    data: { ...(rest.sessionId === undefined ? {} : { sessionId: rest.sessionId }), effectiveBackend: { ...(declaredModel === undefined ? {} : { model: declaredModel }), source: "profile" } },
  };
  const timeout = new AbortController();
  let timedOut = false;
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    timeout.abort(new DOMException(`turn exceeded ${timeoutMs} ms`, "TimeoutError"));
  }, timeoutMs);
  const signal = rest.signal === undefined ? timeout.signal : AbortSignal.any([rest.signal, timeout.signal]);
  let lastUsage: AgentEnvironmentEvent | undefined;
  try {
    for await (const raw of inner.stream({ ...rest, signal })) {
      const event = withoutHarnessCost(raw);
      if (event.usage !== undefined) lastUsage = event;
      if (!isTerminalResult(event)) {
        yield event;
        continue;
      }
      const served = reportedModel(event);
      yield served === undefined ? event : { ...event, data: { ...event.data, effectiveBackend: { model: served, source: "harness" } } };
    }
  } catch (error) {
    if (!timedOut) throw error;
    yield {
      type: "result",
      data: { status: "failed", error: `turn timed out after ${timeoutMs} ms`, errorCode: "timeout", finalText: "" },
      ...(lastUsage?.usage === undefined ? {} : { usage: lastUsage.usage, usageMode: lastUsage.usageMode ?? "cumulative" }),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** An environment rebuilt by `get`: it reaches the sandbox but starts no turn. */
function reconstructedEnvironment(
  sandbox: BridgeSandbox,
  vendor: BridgeSandboxVendor,
  providerCapabilities: AgentEnvironmentCapabilities,
): AgentEnvironment {
  const operations = sandboxOperations(sandbox, vendor, BOX_WORKSPACE_DIR);
  const refuse = (): never => {
    throw new EnvironmentProviderError("refused", "a reconstructed environment starts no turn; create one", { path: "turn", provider: vendor.name });
  };
  let destroyPromise: Promise<void> | undefined;
  return {
    id: sandbox.id,
    provider: vendor.name,
    capabilities: providerCapabilities,
    status: operations.status,
    // eslint-disable-next-line require-yield
    stream: async function* () {
      refuse();
    },
    read: operations.read,
    write: operations.write,
    exec: operations.exec,
    placement: operations.placement,
    destroy(options) {
      destroyPromise ??= sandbox.destroy(options).catch((error) => {
        destroyPromise = undefined;
        throw error;
      });
      return destroyPromise;
    },
  };
}

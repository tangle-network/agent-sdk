import { randomBytes } from "node:crypto";
import type { AgentProfile, HarnessType } from "@tangle-network/agent-interface";
import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
  AgentEnvironmentProvider,
  CreateAgentEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";
import { isEnvironmentProviderError } from "@tangle-network/agent-interface/environment-provider";
import type { ProbeNonces } from "./probe-profile.js";
import type { Recorder } from "./report.js";
import { describeError, waitMs } from "./turns.js";

export interface LiveProfileConformanceOptions {
  /** Provider name for the report. */
  name: string;
  /** Environment variable names the run needs. The first one missing skips the run as `no credential: <NAME>`. */
  credentials: readonly string[];
  /** Where credentials are read from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Builds the provider under test from the environment. Called once per probe that needs a fresh instance. */
  createProvider(): AgentEnvironmentProvider | Promise<AgentEnvironmentProvider>;
  harness: HarnessType;
  /** The model declared in the probe profile. */
  model: string;
  /** Fields every probe create carries, for example `egress` or `resources`. */
  createInput?: Partial<CreateAgentEnvironmentInput>;
  /** The harness binary whose `--version` the pin must equal. Defaults by harness. */
  versionBinary?: string;
  /** `pgrep` arguments that match the harness process. Defaults by harness. */
  harnessProcess?: readonly [string, string];
  /** Secret values that must appear nowhere (SEC-3). Add the Router key here when the adapter was given one. */
  secretValues?: readonly string[];
  /** Parallel create/turn/destroy cycles for CON-1. Defaults to 4. */
  concurrency?: number;
  /** A small public repository cloned at create (WSP-3). Defaults to this SDK at a pinned commit. */
  repository?: { url: string; ref: string; cwd: string; file: string };
  log?(line: string): void;
}

export interface LiveContext {
  options: LiveProfileConformanceOptions;
  rec: Recorder;
  provider: AgentEnvironmentProvider;
  capabilities: AgentEnvironmentCapabilities;
  nonces: ProbeNonces;
  profile: AgentProfile;
  runTag: string;
  /** Errors observed from refused calls, for ERR-1 and ERR-2. */
  refusals: unknown[];
  /** Which profile axes the behavioral probes proved, for checks that depend on them. */
  axes: Partial<Record<"system" | "mcp" | "hook" | "deny" | "subagent", boolean>>;
  /** Create an environment tagged with this run, tracked for cleanup. */
  create(overrides?: Partial<CreateAgentEnvironmentInput>, caseName?: string): Promise<AgentEnvironment>;
  /** Run a create that is expected to be refused; records the error and returns it, or undefined if it succeeded. */
  expectRefusal(overrides: Partial<CreateAgentEnvironmentInput>, caseName: string): Promise<{ refused: boolean; error?: unknown; environment?: AgentEnvironment }>;
  environments: AgentEnvironment[];
  log(line: string): void;
}

export const RUN_TAG_KEY = "conformance-run";

export function newRunTag(): string {
  return `live-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export const DEFAULT_REPOSITORY = {
  url: "https://github.com/tangle-network/agent-sdk.git",
  ref: "143cb43fa27291fc335513dbe8671da884b989d3",
  cwd: "packages/agent-provider-testkit",
  file: "SPEC.md",
} as const;

const VERSION_BINARY: Partial<Record<HarnessType, string>> = {
  "claude-code": "claude",
  codex: "codex",
  opencode: "opencode",
  pi: "pi",
  "kimi-code": "kimi",
};

const HARNESS_PROCESS: Partial<Record<HarnessType, readonly [string, string]>> = {
  "claude-code": ["-x", "claude"],
  codex: ["-x", "codex"],
  opencode: ["-x", "opencode"],
};

export function versionBinary(options: LiveProfileConformanceOptions): string | undefined {
  return options.versionBinary ?? VERSION_BINARY[options.harness];
}

export function harnessProcess(options: LiveProfileConformanceOptions): readonly [string, string] | undefined {
  return options.harnessProcess ?? HARNESS_PROCESS[options.harness];
}

/** Wait until `check` returns true, polling every `everyMs`, for at most `timeoutMs`. */
export async function until(check: () => Promise<boolean>, timeoutMs: number, everyMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return true;
    await waitMs(everyMs);
  }
  return check().catch(() => false);
}

/** Environments the provider lists for this run, by tag. `undefined` when the provider has no `list`. */
export async function listRun(ctx: LiveContext, extra: Record<string, unknown> = {}): Promise<{ id: string; status?: string; case?: string }[] | undefined> {
  if (typeof ctx.provider.list !== "function") return undefined;
  const found = await ctx.provider.list({ metadata: { [RUN_TAG_KEY]: ctx.runTag, ...extra } });
  return found.map((entry) => ({
    id: entry.id,
    ...(entry.status === undefined ? {} : { status: entry.status }),
    ...(typeof entry.metadata?.["conformance-case"] === "string" ? { case: entry.metadata["conformance-case"] } : {}),
  }));
}

/** Whether a refusal names the field: its `path`, or the field's name in its message. */
export function namesField(error: unknown, field: string): boolean {
  const leaf = field.split(".").at(-1) ?? field;
  const path = (error as { path?: unknown }).path;
  const message = error instanceof Error ? error.message : String(error);
  return (typeof path === "string" && path.includes(leaf)) || message.toLowerCase().includes(leaf.toLowerCase());
}

export function errorSummary(error: unknown): string {
  return isEnvironmentProviderError(error) ? `${error.code}${error.path === undefined ? "" : ` at ${error.path}`}: ${error.message.slice(0, 160)}` : describeError(error);
}

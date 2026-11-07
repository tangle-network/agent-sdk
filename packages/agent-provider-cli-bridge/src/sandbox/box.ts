import { HARNESSES } from "@tangle-network/cli-agent-registry";
import type { HarnessType } from "@tangle-network/agent-interface";

/**
 * The box: one image every cloud runs, holding Node, CLI Bridge and the pinned
 * harness CLIs. The Bridge listens on {@link BRIDGE_PORT}, materializes the
 * exact profile and starts the selected harness exactly as it does for Braid
 * on a local machine.
 */
export const BRIDGE_PORT = 3344;
/** The box user's home. */
export const BOX_HOME = "/home/node";
/** The default workspace directory; `workspace.cwd` with `base: "repository"` resolves under it. */
export const BOX_WORKSPACE_DIR = `${BOX_HOME}/workspace`;
export const BRIDGE_DATA_DIR = `${BOX_HOME}/.cli-bridge`;
export const BOX_NODE_IMAGE = "node:24.22.1-trixie-slim";

/**
 * The CLI Bridge source revision the box installs, reviewed as a commit.
 * `agentProfileMaterialize` is the exact version of the planner that revision
 * pins; {@link createBridgeSandboxProvider} plans with the same version, and
 * the image build refuses a revision whose pin differs.
 */
export const BOX_PINS = {
  cliBridgeRepository: "drewstone/cli-bridge",
  cliBridgeCommit: "263f700dc5ca8b7b6e53b986d376102e0d82b42f",
  agentProfileMaterialize: "1.1.4",
} as const;

/** The E2B template and Daytona snapshot name `pnpm build:sandbox-image` publishes for these pins. */
export const BOX_TEMPLATE_NAME = `tangle-cli-bridge-box-${BOX_PINS.cliBridgeCommit.slice(0, 12)}`;

export interface BoxRouter {
  /** Router root URL, without a path. */
  baseUrl: string;
  /** The per-run capped Router key. */
  key: string;
}

/** A harness the box carries and routes through the Tangle Router. */
export interface BoxHarness {
  readonly harness: HarnessType;
  /** The Bridge backend name in `BRIDGE_BACKENDS`. */
  readonly bridgeBackend: string;
  /** The npm package that installs the CLI at the catalog's version. */
  readonly npmPackage: string;
  /** Environment that points this harness at the Router, set on the Bridge process only. */
  routerEnv(router: BoxRouter): Record<string, string>;
}

/** Why a catalog harness is not in the box, and who owns closing the gap. */
export interface BoxExclusion {
  readonly reason: string;
  readonly owner: string;
}

// The catalog is the registry's HARNESSES, generated from agent-container's infra/nix/agent-clis.json: the pins
// the Tangle sandbox image is built from. The box decides only how it installs and routes a catalog harness.
type Catalog = typeof HARNESSES;
type CatalogHarness = keyof Catalog & HarnessType;
/** Harnesses whose catalog entry has no native CLI or no Router endpoint; the catalog says why. */
type RouterIneligible = {
  [H in CatalogHarness]: Catalog[H] extends { session: { kind: "native" }; config: { baseUrl: "caller-or-managed" } } ? never : H;
}[CatalogHarness];

const unproven: BoxExclusion = { reason: "no live Router turn in a box yet", owner: "tangle-network/agent-sdk" };
const noBridgeBackend: BoxExclusion = { reason: `CLI Bridge ${BOX_PINS.cliBridgeCommit.slice(0, 12)} registers no backend for it`, owner: BOX_PINS.cliBridgeRepository };

/**
 * Every Router-eligible catalog harness, as a recipe or an exclusion; the type
 * fails when the registry adds a harness the box does not place. A recipe joins
 * only after a live turn through the Router completed in a box.
 */
const BOX_ROWS: { readonly [H in Exclude<CatalogHarness, RouterIneligible>]: Omit<BoxHarness, "harness"> | BoxExclusion } = {
  // The Router authenticates a Bearer token. ANTHROPIC_API_KEY sends x-api-key, which it rejects.
  "claude-code": { bridgeBackend: "claude", npmPackage: "@anthropic-ai/claude-code", routerEnv: (router) => ({ ANTHROPIC_BASE_URL: router.baseUrl, ANTHROPIC_AUTH_TOKEN: router.key }) },
  codex: unproven,
  opencode: unproven,
  pi: unproven,
  "kimi-code": { reason: "the catalog pins Python kimi-cli 1.49.0, which refuses the Bridge's Kimi Code argv (`--output-format stream-json` without `--print`, exit 2); it joins once the catalog ports to npm @moonshot-ai/kimi-code (ops-board#10682)", owner: "tangle-network/agent-container (cli-agent-registry)" },
  prime: unproven,
  hermes: { reason: "hermes 0.22.4 has no PyPI or official npm release, and the registry publishes no install source (git repository, ref, installer) for it; after that, the Bridge's AcpBackend forwards no request model to `hermes acp`", owner: "tangle-network/agent-container (cli-agent-registry)" },
  openclaw: { reason: `CLI Bridge ${BOX_PINS.cliBridgeCommit.slice(0, 12)} runs \`openclaw acp\`, a client of an OpenClaw Gateway the box never starts (ECONNREFUSED 127.0.0.1:18789) that also rejects per-session MCP; openclaw reads its endpoint only from an openclaw.json the Bridge never writes`, owner: BOX_PINS.cliBridgeRepository },
  "factory-droids": noBridgeBackend,
  grok: noBridgeBackend,
  nanoclaw: noBridgeBackend,
  acp: noBridgeBackend,
};

const rows = Object.entries(BOX_ROWS) as Array<[HarnessType, Omit<BoxHarness, "harness"> | BoxExclusion]>;

export const BOX_HARNESSES: Readonly<Partial<Record<HarnessType, BoxHarness>>> = Object.fromEntries(
  rows.flatMap(([harness, row]) => ("npmPackage" in row ? [[harness, { harness, ...row }]] : [])),
);

/** Every catalog harness the box does not carry, with the reason and its owner. */
export const BOX_EXCLUSIONS: Readonly<Partial<Record<HarnessType, BoxExclusion>>> = Object.fromEntries([
  ...rows.filter(([, row]) => !("npmPackage" in row)),
  ...Object.entries(HARNESSES as Record<string, { config: { baseUrl?: string } }>)
    .filter(([harness]) => !(harness in BOX_ROWS))
    .map(([harness, { config }]) => [harness, {
      reason: config.baseUrl === "vendor-only" ? "the catalog declares it vendor-only: no Router endpoint" : "the catalog declares no native CLI for it",
      owner: "tangle-network/agent-container (cli-agent-registry)",
    }]),
]);

export function boxHarness(harness: string | undefined): BoxHarness | undefined {
  return harness === undefined ? undefined : (BOX_HARNESSES as Record<string, BoxHarness | undefined>)[harness];
}

function catalogCli(harness: HarnessType): { versionCommand: string; cliVersion: string } {
  const session = (HARNESSES as Record<string, { session: { kind: string; processProbe?: { versionCommand: string }; contract?: { cliVersion: string } } } | undefined>)[harness]?.session;
  if (session?.kind !== "native") throw new Error(`the harness catalog declares no native CLI for ${harness}`);
  return { versionCommand: session.processProbe!.versionCommand, cliVersion: session.contract!.cliVersion };
}

/** The CLI version the harness catalog pins; the box image installs exactly this. */
export const boxHarnessVersion = (harness: HarnessType): string => catalogCli(harness).cliVersion;

/** The catalog's command that prints the installed CLI version. */
export const boxVersionCommand = (harness: HarnessType): string => catalogCli(harness).versionCommand;

/** A shell test that the version command prints the pin as one token, with or without a leading `v` (`codex-cli 0.164.0`). */
export function boxVersionProbe(harness: HarnessType): string {
  const { versionCommand, cliVersion } = catalogCli(harness);
  return `(${versionCommand}) 2>&1 | tr -s ' \\t' '\\n\\n' | sed 's/^v//' | grep -Fxq -- '${cliVersion}'`;
}

/** The one install step every box runs, the image build and Boat's setup script alike: the pinned CLIs and Bridge, then a version probe for each. */
export function boxInstallScript(harnesses: readonly HarnessType[]): string {
  if (harnesses.length === 0) throw new Error("no harness to install; the box needs at least one");
  const entries = harnesses.map((name) => {
    const entry = boxHarness(name);
    if (entry === undefined) throw new Error(`harness ${name} is not in the box: ${(BOX_EXCLUSIONS as Record<string, BoxExclusion | undefined>)[name]?.reason ?? "not in the harness catalog"}`);
    return entry;
  });
  const bridge = `https://github.com/${BOX_PINS.cliBridgeRepository}/archive/${BOX_PINS.cliBridgeCommit}.tar.gz`;
  const packages = entries.map((entry) => `${entry.npmPackage}@${boxHarnessVersion(entry.harness)}`);
  return [`npm install -g ${[...packages, bridge].join(" ")}`, ...entries.map((entry) => boxVersionProbe(entry.harness)), "command -v cli-bridge >/dev/null"].join(" \\\n    && ");
}

/** The command that starts the Bridge; its settings come from the process environment. */
export const BRIDGE_START_COMMAND = "cli-bridge";

/**
 * The Bridge process environment. `bearer` guards the exposed port; the Router
 * variables reach the harness through the Bridge's child environment and
 * appear in no command line or file.
 */
export function bridgeProcessEnv(harness: BoxHarness, bearer: string, router: BoxRouter): Record<string, string> {
  return {
    BRIDGE_HOST: "0.0.0.0",
    BRIDGE_PORT: String(BRIDGE_PORT),
    BRIDGE_BEARER: bearer,
    BRIDGE_BACKENDS: harness.bridgeBackend,
    BRIDGE_DATA_DIR: BRIDGE_DATA_DIR,
    BRIDGE_JAIL_MODE: "off",
    HOME: BOX_HOME,
    ...harness.routerEnv(router),
  };
}

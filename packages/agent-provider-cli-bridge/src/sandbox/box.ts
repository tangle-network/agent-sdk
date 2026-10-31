import { NATIVE_SESSION_CONTRACTS } from "@tangle-network/cli-agent-registry/native-session-contracts";
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

export interface BoxRouter {
  /** Router root URL, without a path. */
  baseUrl: string;
  /** The per-run capped Router key. */
  key: string;
}

/**
 * A harness the box carries and routes through the Tangle Router.
 *
 * A harness joins this table only after a live turn through the Router
 * completed in a box, so the declared set is the proven set.
 */
export interface BoxHarness {
  readonly harness: HarnessType;
  /** The Bridge backend name in `BRIDGE_BACKENDS`. */
  readonly bridgeBackend: string;
  /** The npm package that installs the CLI. */
  readonly npmPackage: string;
  /** The CLI binary; `<bin> --version` prints the pinned version first. */
  readonly bin: string;
  /** Environment that points this harness at the Router, set on the Bridge process only. */
  routerEnv(router: BoxRouter): Record<string, string>;
}

export const BOX_HARNESSES: Readonly<Partial<Record<HarnessType, BoxHarness>>> = {
  "claude-code": {
    harness: "claude-code",
    bridgeBackend: "claude",
    npmPackage: "@anthropic-ai/claude-code",
    bin: "claude",
    // The Router authenticates a Bearer token. ANTHROPIC_API_KEY sends x-api-key, which it rejects.
    routerEnv: (router) => ({
      ANTHROPIC_BASE_URL: router.baseUrl,
      ANTHROPIC_AUTH_TOKEN: router.key,
    }),
  },
};

export function boxHarness(harness: string | undefined): BoxHarness | undefined {
  return harness === undefined ? undefined : (BOX_HARNESSES as Record<string, BoxHarness | undefined>)[harness];
}

/** The CLI version the harness registry pins; the box image installs exactly this. */
export function boxHarnessVersion(harness: HarnessType): string {
  const contract = (NATIVE_SESSION_CONTRACTS as Record<string, { cliVersion?: string } | undefined>)[harness];
  if (contract?.cliVersion === undefined) {
    throw new Error(`cli-agent-registry pins no CLI version for harness ${harness}`);
  }
  return contract.cliVersion;
}

/** The command that starts the Bridge; its settings come from the process environment. */
export const BRIDGE_START_COMMAND = "cli-bridge";

/**
 * The Bridge process environment. `bearer` guards the exposed port; the Router
 * variables reach the harness through the Bridge's child environment and
 * appear in no command line or file.
 */
export function bridgeProcessEnv(
  harness: BoxHarness,
  bearer: string,
  router: BoxRouter,
): Record<string, string> {
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

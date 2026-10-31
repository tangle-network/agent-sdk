import { BOX_HARNESSES, BOX_HOME, BOX_NODE_IMAGE, BOX_PINS, BOX_WORKSPACE_DIR, boxHarnessVersion } from "./box.js";
import type { HarnessType } from "@tangle-network/agent-interface";

/**
 * The box image as one Dockerfile.
 *
 * Every cloud builds from this text: E2B and Daytona build their template and
 * image from it, and a local Docker build of it is the same box. Harness
 * versions come from the registry that owns the pins.
 */
export function renderBoxDockerfile(harnesses: readonly HarnessType[] = Object.keys(BOX_HARNESSES) as HarnessType[]): string {
  const installs = harnesses.map((name) => {
    const entry = BOX_HARNESSES[name];
    if (entry === undefined) throw new Error(`harness ${name} is not in the box harness table`);
    return { entry, version: boxHarnessVersion(name) };
  });
  const bridge = `https://github.com/${BOX_PINS.cliBridgeRepository}/archive/${BOX_PINS.cliBridgeCommit}.tar.gz`;
  const packages = installs.map(({ entry, version }) => `${entry.npmPackage}@${version}`);
  const probes = installs.map(({ entry, version }) => `test "$(${entry.bin} --version | cut -d' ' -f1)" = "${version}"`);
  return [
    `FROM ${BOX_NODE_IMAGE}`,
    "RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates python3 make g++ ripgrep procps \\",
    "    && rm -rf /var/lib/apt/lists/*",
    `RUN npm install -g ${[...packages, bridge].join(" ")} \\`,
    `    && ${[...probes, "command -v cli-bridge >/dev/null"].join(" \\\n    && ")}`,
    `RUN mkdir -p ${BOX_WORKSPACE_DIR} && chown -R node:node ${BOX_HOME}`,
    "USER node",
    `ENV HOME=${BOX_HOME}`,
    `WORKDIR ${BOX_WORKSPACE_DIR}`,
    "",
  ].join("\n");
}

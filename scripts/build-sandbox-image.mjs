// Builds the CLI Bridge box from renderBoxDockerfile() as a Docker image, an E2B template or a
// Daytona snapshot. Logs go to stderr; the last stdout line is `<TARGET>=<name-or-id>`.
// Usage: node scripts/build-sandbox-image.mjs --target <e2b|daytona|docker> [--name <name>]
//          [--harnesses claude-code,...] [--print [--skip-pin-check]]
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandboxEntry = join(root, "packages/agent-provider-cli-bridge/dist/sandbox/index.js");
const log = (line) => process.stderr.write(`${line}\n`);

class Failure extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

// The vendor SDKs are optional peers of their provider packages, so resolve them from there.
async function loadSdk(packageDirectory, specifier) {
  const manifest = join(root, "packages", packageDirectory, "package.json");
  let entry;
  try {
    entry = createRequire(manifest).resolve(specifier);
  } catch {
    throw new Failure(`${specifier} is not installed for packages/${packageDirectory}; run pnpm install`);
  }
  return import(pathToFileURL(entry).href);
}

// The provider plans profiles with BOX_PINS.agentProfileMaterialize; the Bridge revision must pin the same.
async function verifyBridgePin({ cliBridgeRepository, cliBridgeCommit, agentProfileMaterialize }) {
  const url = `https://raw.githubusercontent.com/${cliBridgeRepository}/${cliBridgeCommit}/package.json`;
  let manifest;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    manifest = await response.json();
  } catch (error) {
    throw new Failure(`cannot verify the CLI Bridge pin: fetching ${url} failed: ${error.message}`);
  }
  const pinned = manifest.dependencies?.["@tangle-network/agent-profile-materialize"];
  if (pinned !== agentProfileMaterialize) {
    throw new Failure(
      `CLI Bridge ${cliBridgeRepository}@${cliBridgeCommit} depends on @tangle-network/agent-profile-materialize ` +
        `${pinned ?? "(absent)"}, but BOX_PINS.agentProfileMaterialize is ${agentProfileMaterialize}; ` +
        "the box would materialize profiles with a different planner than the provider",
    );
  }
  log(`CLI Bridge pin verified: ${cliBridgeRepository}@${cliBridgeCommit} uses agent-profile-materialize ${pinned}`);
}

const targets = {
  docker: {
    output: "DOCKER_IMAGE",
    defaultName: (revision) => `tangle-cli-bridge-box:${revision}`,
    async build({ dockerfile, name, box, harnesses }) {
      const built = spawnSync("docker", ["build", "-t", name, "-"], { input: dockerfile, stdio: ["pipe", 2, 2] });
      if (built.error) throw new Failure(`docker could not start: ${built.error.message}`);
      if (built.status !== 0) throw new Failure(`docker build of ${name} exited ${built.status}`);
      const checks = [
        ["cli-bridge is on PATH", "command -v cli-bridge"],
        ["the container user is node", 'test "$(id -un)" = node'],
        [`HOME is ${box.BOX_HOME}`, `test "$HOME" = ${box.BOX_HOME}`],
        [`${box.BOX_WORKSPACE_DIR} is the writable working directory`, `test "$PWD" = ${box.BOX_WORKSPACE_DIR} && test -w .`],
        ...harnesses.map((harness) => {
          const { bin } = box.BOX_HARNESSES[harness];
          const version = box.boxHarnessVersion(harness);
          return [`${bin} --version is ${version} as node`, `test "$(${bin} --version | cut -d' ' -f1)" = "${version}"`];
        }),
      ];
      for (const [label, test] of checks) {
        const { status } = spawnSync("docker", ["run", "--rm", name, "sh", "-c", test], { stdio: ["ignore", 2, 2] });
        if (status !== 0) throw new Failure(`box check failed: ${label} (\`${test}\` exited ${status})`);
        log(`ok: ${label}`);
      }
      const inspect = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}} {{.Size}}", name], { encoding: "utf8" });
      const [id, size] = inspect.stdout.trim().split(" ");
      log(`image ${name} ${id} ${Math.round(Number(size) / 1e6)} MB`);
      return name;
    },
  },
  e2b: {
    credential: "E2B_API_KEY",
    output: "E2B_TEMPLATE",
    defaultName: (revision) => `tangle-cli-bridge-box-${revision}`,
    async build({ dockerfile, name, apiKey }) {
      const { Template } = await loadSdk("agent-provider-e2b", "e2b");
      const info = await Template.build(Template().fromDockerfile(dockerfile), name, {
        apiKey,
        onBuildLogs: (entry) => log(entry.toString()),
      });
      log(`E2B template ${info.name} id ${info.templateId} build ${info.buildId}`);
      return info.templateId;
    },
  },
  daytona: {
    credential: "DAYTONA_API_KEY",
    output: "DAYTONA_SNAPSHOT",
    defaultName: (revision) => `tangle-cli-bridge-box-${revision}`,
    async build({ dockerfile, name, apiKey }) {
      const { Daytona, Image } = await loadSdk("agent-provider-daytona", "@daytonaio/sdk");
      const directory = mkdtempSync(join(tmpdir(), "tangle-cli-bridge-box-"));
      try {
        writeFileSync(join(directory, "Dockerfile"), dockerfile);
        const image = Image.fromDockerfile(join(directory, "Dockerfile"));
        // DAYTONA_API_URL and DAYTONA_TARGET are read from the environment by the SDK.
        const snapshot = await new Daytona({ apiKey }).snapshot.create(
          { name, image },
          { onLogs: (chunk) => log(chunk.trimEnd()) },
        );
        log(`Daytona snapshot ${snapshot.name} is ${snapshot.state}`);
        return snapshot.name;
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  },
};

async function main() {
  const { values } = parseArgs({
    options: {
      target: { type: "string" },
      name: { type: "string" },
      harnesses: { type: "string" },
      print: { type: "boolean", default: false },
      "skip-pin-check": { type: "boolean", default: false },
    },
  });
  if (values["skip-pin-check"] && !values.print) {
    throw new Failure("--skip-pin-check only applies to --print; a build always verifies the CLI Bridge pin");
  }
  const target = Object.hasOwn(targets, values.target) ? targets[values.target] : undefined;
  if (!values.print && target === undefined) {
    throw new Failure(`--target must be one of ${Object.keys(targets).join(", ")} (got ${values.target ?? "nothing"})`);
  }
  let box;
  try {
    box = await import(pathToFileURL(sandboxEntry).href);
  } catch (error) {
    throw new Failure(
      `cannot load the built CLI Bridge sandbox module (${error.message}); build it and its workspace ` +
        `dependencies with: pnpm --filter "@tangle-network/agent-provider-cli-bridge..." build`,
    );
  }
  const harnesses = values.harnesses?.split(",").map((name) => name.trim()).filter(Boolean) ?? Object.keys(box.BOX_HARNESSES);
  const dockerfile = box.renderBoxDockerfile(harnesses);
  const apiKey = target?.credential && process.env[target.credential];
  if (!values.print && target.credential && !apiKey) {
    throw new Failure(`no credential: ${target.credential}`, 3);
  }
  if (!values["skip-pin-check"]) await verifyBridgePin(box.BOX_PINS);
  if (values.print) {
    process.stdout.write(dockerfile);
    return;
  }
  const name = values.name ?? target.defaultName(box.BOX_PINS.cliBridgeCommit.slice(0, 12));
  const result = await target.build({ dockerfile, name, box, harnesses, apiKey });
  process.stdout.write(`${target.output}=${result}\n`);
}

// Exit explicitly: a vendor SDK's keep-alive sockets must not hold a finished release step open.
main().then(
  () => process.exit(0),
  (error) => {
    log(error instanceof Failure ? error.message : (error?.stack ?? String(error)));
    process.exit(error instanceof Failure ? error.exitCode : 1);
  },
);

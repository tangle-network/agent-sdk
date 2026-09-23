import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bridgeRoot = resolveRequiredPath("CLI_BRIDGE_SOURCE_DIR");
const expectedRevision = requiredEnv("CLI_BRIDGE_EXPECTED_SHA");
const actualRevision = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: bridgeRoot,
  encoding: "utf8",
});
if (actualRevision.status !== 0 || actualRevision.stdout.trim() !== expectedRevision) {
  throw new Error(
    `CLI Bridge checkout is ${JSON.stringify(actualRevision.stdout.trim())}, expected ${JSON.stringify(expectedRevision)}`,
  );
}

const bridgeCli = join(bridgeRoot, "dist", "cli.js");
const fakePi = join(workspaceRoot, "scripts", "fixtures", "fake-pi-rpc.mjs");
const temporaryRoot = mkdtempSync(join(tmpdir(), "agent-sdk-cli-bridge-live-"));
const resultsPath = join(temporaryRoot, "vitest-results.json");
chmodSync(fakePi, 0o755);

let bridgeProcess;
let bridgeExit;
let bridgeStdout = "";
let bridgeStderr = "";

try {
  const port = await reservePort();
  bridgeProcess = spawn(process.execPath, [bridgeCli], {
    cwd: temporaryRoot,
    env: {
      ...process.env,
      BRIDGE_HOST: "127.0.0.1",
      BRIDGE_PORT: String(port),
      BRIDGE_DATA_DIR: join(temporaryRoot, "bridge-data"),
      BRIDGE_BACKENDS: "pi",
      BRIDGE_DEFAULT_EXECUTOR: "host",
      PI_EXECUTOR: "host",
      PI_BIN: fakePi,
      PI_CODING_AGENT_DIR: join(temporaryRoot, "pi-agent"),
      PI_TIMEOUT_MS: "10000",
      BRIDGE_HEALTH_PROBE_TIMEOUT_MS: "1000",
      BRIDGE_JAIL_MODE: "off",
      BRIDGE_NET_JAIL_MODE: "off",
      BRIDGE_TRACE: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridgeProcess.stdout.on("data", (chunk) => {
    bridgeStdout += chunk.toString();
  });
  bridgeProcess.stderr.on("data", (chunk) => {
    bridgeStderr += chunk.toString();
  });
  bridgeExit = new Promise((resolveExit) => {
    bridgeProcess.once("exit", (code, signal) => resolveExit({ code, signal }));
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForReady(`${baseUrl}/health`, bridgeExit, 20_000);
  const test = await run("pnpm", [
    "--filter",
    "@tangle-network/agent-provider-cli-bridge",
    "exec",
    "vitest",
    "run",
    "src/w3-local.test.ts",
    "--reporter=json",
    `--outputFile=${resultsPath}`,
  ], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      CLI_BRIDGE_LIVE_URL: baseUrl,
      CLI_BRIDGE_LIVE_MODEL: "pi/test",
      CLI_BRIDGE_LIVE_TURN: "1",
    },
  });
  if (test.code !== 0) {
    const report = existsSync(resultsPath) ? readFileSync(resultsPath, "utf8") : "no JSON report was written";
    throw new Error(`live provider tests exited ${test.code}\n${test.stdout}\n${test.stderr}\n${report}`);
  }

  const results = JSON.parse(readFileSync(resultsPath, "utf8"));
  if (
    results.numTotalTests !== 4 ||
    results.numPassedTests !== 4 ||
    results.numFailedTests !== 0 ||
    results.numPendingTests !== 0 ||
    results.numTodoTests !== 0
  ) {
    throw new Error(`live provider tests did not run four of four cases: ${JSON.stringify({
      total: results.numTotalTests,
      passed: results.numPassedTests,
      failed: results.numFailedTests,
      pending: results.numPendingTests,
      todo: results.numTodoTests,
    })}`);
  }

  bridgeProcess.kill("SIGTERM");
  const exit = await withTimeout(bridgeExit, 10_000, "CLI Bridge did not stop after SIGTERM");
  if (exit.code !== 0 || exit.signal !== null) {
    throw new Error(`CLI Bridge stopped unexpectedly: ${JSON.stringify(exit)}`);
  }
  await assertClosed(port);
  process.stdout.write(`CLI Bridge provider contract passed: 4/4 tests at ${expectedRevision}\n`);
} catch (error) {
  const bridgeOutput = [bridgeStdout.trim(), bridgeStderr.trim()].filter(Boolean).join("\n");
  throw new Error(`${error instanceof Error ? error.message : String(error)}${bridgeOutput ? `\n${bridgeOutput}` : ""}`);
} finally {
  if (bridgeProcess && bridgeProcess.exitCode === null && bridgeProcess.signalCode === null) {
    bridgeProcess.kill("SIGKILL");
    await Promise.race([bridgeExit, new Promise((resolveWait) => setTimeout(resolveWait, 2_000))]);
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function resolveRequiredPath(name) {
  return resolve(requiredEnv(name));
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not reserve a local port");
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  return address.port;
}

async function waitForReady(url, exitPromise, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await Promise.race([
      fetch(url).then(async (response) => ({ type: "health", response, body: await response.text() })).catch(() => null),
      exitPromise.then((exit) => ({ type: "exit", exit })),
      new Promise((resolveWait) => setTimeout(() => resolveWait(null), 100)),
    ]);
    if (state?.type === "exit") throw new Error(`CLI Bridge exited before readiness: ${JSON.stringify(state.exit)}`);
    if (state?.type === "health" && state.response.ok) return;
  }
  throw new Error(`CLI Bridge did not become ready within ${timeoutMs}ms`);
}

function run(command, args, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function assertClosed(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/health`);
  } catch {
    return;
  }
  throw new Error(`CLI Bridge listener on ${port} remained open after shutdown`);
}

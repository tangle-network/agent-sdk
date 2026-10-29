import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const BRIDGE_ROOT = process.env.CLI_BRIDGE_INTEGRATION_ROOT?.trim();

/** A real child speaking the Pi JSONL RPC protocol through the actual bridge app. */
const fakePi = String.raw`#!/usr/bin/python3
import json
import os
import re
import sys
import traceback

args = sys.argv[1:]
trace_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fake-pi.trace")

def record(value):
    with open(trace_path, "a", encoding="utf-8") as trace:
        trace.write(json.dumps(value) + "\n")

record({"kind": "process", "pid": os.getpid(), "args": args})

def record_exception(kind, value, tb):
    with open(trace_path, "a", encoding="utf-8") as trace:
        trace.write("\n" + "".join(traceback.format_exception(kind, value, tb)))

sys.excepthook = record_exception

if len(args) >= 2 and args[0] == "auth" and args[1] == "print-api-key":
    print("sdk-cli-bridge-integration-token", flush=True)
    raise SystemExit(0)

if "--version" in args:
    print("pi integration fixture", flush=True)
    raise SystemExit(0)

extension_path = args[args.index("--extension") + 1]
extension = open(extension_path, encoding="utf-8").read()
nonce_match = re.search(r"""const bridgeNonce = ["']([^"']+)["']""", extension)
if nonce_match is None:
    raise RuntimeError("the actual Bridge did not expose its native interaction extension")
permission_token = nonce_match.group(1) + "-1"
permission_title = "Permission: bash [cli-bridge-marker:" + permission_token + "]"

def send(value):
    print(json.dumps(value), flush=True)

turns = 0
for line in sys.stdin:
    message = json.loads(line)
    kind = message.get("type")
    if kind == "prompt":
        turns += 1
        prompt_message = str(message.get("message") or "")
        record({"kind": "command", "pid": os.getpid(), "type": "prompt", "turn": turns, "message": prompt_message})
        send({"id": message.get("id"), "type": "response", "command": "prompt", "success": True})
        send({"type": "session", "id": "actual-bridge-pi-session"})
        send({"type": "agent_start"})
        send({"type": "turn_start"})
        identity_marker = None
        if "identity-a" in prompt_message:
            identity_marker = "identity-a"
        elif "identity-b" in prompt_message:
            identity_marker = "identity-b"
        if identity_marker is not None:
            send({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": identity_marker}})
            send({"type": "turn_end", "message": {"usage": {"input": 3, "output": 1}}})
            send({"type": "agent_end"})
            send({"type": "agent_settled"})
            continue
        if turns == 1:
            send({"type": "message_update", "assistantMessageEvent": {"type": "thinking_delta", "contentIndex": 0, "delta": "native reasoning"}})
            send({"type": "plan_submitted", "plan": {"id": "native-plan", "revision": 1, "title": "Native plan", "body": "Use the retained interaction path.", "submittedAt": "2026-08-28T00:00:00.000Z"}})
            send({"type": "extension_ui_request", "id": "native-permission", "method": "select", "title": permission_title, "options": ["allow_once", "deny"]})
        else:
            send({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "native continuation accepted"}})
            send({"type": "turn_end", "message": {"usage": {"input": 5, "output": 4}}})
            send({"type": "agent_end"})
            send({"type": "agent_settled"})
    elif kind == "extension_ui_response" and message.get("id") == "native-permission":
        value = str(message.get("value"))
        send({"type": "extension_ui_request", "id": "marker-notification", "method": "notify", "message": "cli-bridge.permission-applied.v1:" + permission_token + ":" + value})
        send({"type": "tool_execution_start", "toolCallId": "actual-tool", "toolName": "bash", "args": {"command": "printf integration"}})
        send({"type": "tool_execution_end", "toolCallId": "actual-tool", "toolName": "bash", "args": {"command": "printf integration"}, "result": "integration", "isError": False})
        send({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "native response accepted"}})
        send({"type": "turn_end", "message": {"usage": {"input": 4, "output": 3}}})
        send({"type": "agent_end"})
        send({"type": "agent_settled"})
    elif kind == "get_state":
        send({"id": message.get("id"), "type": "response", "command": "get_state", "success": True, "data": {"sessionId": "actual-bridge-pi-session", "messageCount": turns * 2}})
    elif kind == "abort":
        send({"id": message.get("id"), "type": "response", "command": "abort", "success": True})
`;

interface FakePiTraceEntry {
  readonly kind?: string;
  readonly pid?: number;
  readonly args?: string[];
  readonly type?: string;
  readonly turn?: number;
  readonly message?: string;
}

interface RunningBridge {
  readonly baseUrl: string;
  readonly projectDir: string;
  readonly logs: () => string;
  readonly readPiTrace: () => FakePiTraceEntry[];
  readonly restart: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

export async function startActualBridge(harness: "pi" | "claude" = "pi"): Promise<RunningBridge> {
  if (!BRIDGE_ROOT) {
    throw new Error("CLI_BRIDGE_INTEGRATION_ROOT must name an installed cli-bridge source checkout");
  }
  const bridgeTsx = join(BRIDGE_ROOT, "node_modules", ".bin", "tsx");
  const fixtureRoot = mkdtempSync(join(homedir(), ".cache", "agent-sdk-cli-bridge-"));
  const dataDir = join(fixtureRoot, "data");
  const agentDir = join(fixtureRoot, "pi-agent");
  const projectDir = join(fixtureRoot, "project");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  const fakePiPath = join(projectDir, "fake-pi");
  const fakeClaudePath = join(projectDir, "fake-claude");
  writeFileSync(fakeClaudePath, readFileSync(new URL("./fixtures/claude-evidence.py", import.meta.url)), { mode: 0o700 });
  const fakePiTracePath = join(projectDir, "fake-pi.trace");
  writeFileSync(fakePiPath, fakePi, { encoding: "utf8", mode: 0o700 });
  chmodSync(fakePiPath, 0o700);
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "tangle-router": {
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:9/v1",
          models: [{ id: "sdk-integration-model", api: "openai-completions" }],
        },
      },
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  const port = await freePort();
  const spawnBridge = (): ReturnType<typeof spawn> => spawn(bridgeTsx, ["src/server.ts"], {
    cwd: BRIDGE_ROOT,
    env: {
      ...process.env,
      BRIDGE_HOST: "127.0.0.1",
      BRIDGE_PORT: String(port),
      BRIDGE_BACKENDS: harness,
      CLAUDE_BIN: fakeClaudePath,
      BRIDGE_DATA_DIR: dataDir,
      BRIDGE_JAIL_MODE: "fs-jail",
      BRIDGE_TRACE: "off",
      CLI_TIMEOUT_MS: "10000",
      PI_TIMEOUT_MS: "10000",
      PI_BIN: fakePiPath,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let child = spawnBridge();
  let output = "";
  const append = (chunk: Buffer): void => {
    output = `${output}${chunk.toString()}`.slice(-30_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  let stopped = false;
  const restart = async (): Promise<void> => {
    if (stopped) throw new Error("cannot restart a stopped actual Bridge fixture");
    await stopChild(child);
    child = spawnBridge();
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    await waitForBridge(child, `http://127.0.0.1:${port}`, () => output);
  };
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await stopChild(child);
    rmSync(fixtureRoot, { recursive: true, force: true });
    if (existsSync(fixtureRoot)) {
      throw new Error("actual Bridge fixture cleanup left its temporary root");
    }
  };
  try {
    await waitForBridge(child, `http://127.0.0.1:${port}`, () => output);
  } catch (error) {
    await stop();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nActual Bridge output:\n${output}`,
    );
  }
  const logs = (): string => {
    const trace = existsSync(fakePiTracePath)
      ? readFileSync(fakePiTracePath, "utf8")
      : "<fake Pi did not start>";
    return `${output}\nFake Pi trace:\n${trace}`;
  };
  const readPiTrace = (): FakePiTraceEntry[] => {
    if (!existsSync(fakePiTracePath)) return [];
    return readFileSync(fakePiTracePath, "utf8")
      .split(/\r?\n/u)
      .flatMap((line): FakePiTraceEntry[] => {
        if (!line.trim()) return [];
        try {
          const value = JSON.parse(line) as unknown;
          return value && typeof value === "object"
            ? [value as FakePiTraceEntry]
            : [];
        } catch {
          return [];
        }
      });
  };
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    projectDir,
    logs,
    readPiTrace,
    restart,
    stop,
  };
}

async function waitForBridge(
  child: ReturnType<typeof spawn>,
  baseUrl: string,
  logs: () => string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`actual Bridge exited during startup with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/`);
      if (response.ok) return;
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`actual Bridge did not listen within 15000ms\n${logs()}`);
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("exit", finish);
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, 5_000);
    timer.unref();
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("could not determine the actual Bridge integration port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

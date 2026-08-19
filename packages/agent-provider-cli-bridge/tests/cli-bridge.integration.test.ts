import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  interactionResponseCommandDigest,
  type AgentEnvironmentEvent,
  type AgentExactRunControlRef,
  type InteractionAcknowledgement,
  type InteractionRequest,
  type InteractionResponse,
  type InteractionResponseCommand,
} from "@tangle-network/agent-interface";
import { describe, expect, it } from "vitest";
import { createCliBridgeProvider } from "../src/index.js";

const BRIDGE_ROOT = process.env.CLI_BRIDGE_INTEGRATION_ROOT?.trim();
const describeActualBridge = BRIDGE_ROOT ? describe : describe.skip;

/** A real child speaking the Pi JSONL RPC protocol through the actual bridge app. */
const fakePi = String.raw`#!/usr/bin/python3
import json
import os
import re
import sys
import traceback

args = sys.argv[1:]
trace_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fake-pi.trace")
with open(trace_path, "a", encoding="utf-8") as trace:
    trace.write(json.dumps({"pid": os.getpid(), "args": args}) + "\n")

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

for line in sys.stdin:
    message = json.loads(line)
    kind = message.get("type")
    if kind == "prompt":
        send({"id": message.get("id"), "type": "response", "command": "prompt", "success": True})
        send({"type": "session", "id": "actual-bridge-pi-session"})
        send({"type": "agent_start"})
        send({"type": "extension_ui_request", "id": "native-permission", "method": "select", "title": permission_title, "options": ["allow_once", "deny"]})
    elif kind == "extension_ui_response" and message.get("id") == "native-permission":
        value = str(message.get("value"))
        send({"type": "extension_ui_request", "id": "marker-notification", "method": "notify", "message": "cli-bridge.permission-applied.v1:" + permission_token + ":" + value})
        send({"type": "tool_execution_start", "toolCallId": "actual-tool", "toolName": "bash", "args": {"command": "printf integration"}})
        send({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "native response accepted"}})
        send({"type": "turn_end", "message": {"usage": {"input": 4, "output": 3}}})
        send({"type": "agent_end"})
        send({"type": "agent_settled"})
    elif kind == "get_state":
        send({"id": message.get("id"), "type": "response", "command": "get_state", "success": True, "data": {"sessionId": "actual-bridge-pi-session", "messageCount": 2}})
    elif kind == "abort":
        send({"id": message.get("id"), "type": "response", "command": "abort", "success": True})
`;

interface RunningBridge {
  readonly baseUrl: string;
  readonly projectDir: string;
  readonly logs: () => string;
  readonly restart: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

describeActualBridge("actual cli-bridge native interaction contract", () => {
  it("dispatches, replays from a nonzero cursor, survives Bridge restart, and retries idempotently", async () => {
    const bridge = await startActualBridge();
    const requests: Array<{ method: string; pathname: string; lastEventId: string | null }> = [];
    const bridgeFetch: typeof fetch = async (url, init) => {
      requests.push({
        method: init?.method ?? "GET",
        pathname: new URL(String(url)).pathname,
        lastEventId: new Headers(init?.headers).get("last-event-id"),
      });
      return fetch(url, init);
    };

    try {
      const environmentId = "sdk-cli-bridge-integration-environment";
      const sessionId = "sdk-cli-bridge-integration-session";
      const provider = createCliBridgeProvider({
        baseUrl: bridge.baseUrl,
        defaultModel: "pi/tangle-router/sdk-integration-model",
        fetch: bridgeFetch,
      });
      const capabilities = await provider.capabilities();
      expect(capabilities.profile.resources.files).toBe(false);
      expect(capabilities.profile.resources.tools).toBe(false);
      expect(capabilities.profile.validation).toBe(false);
      expect(capabilities.sessions).toEqual({ continue: true, list: false, messages: false });
      expect(capabilities.nativeContinuation).toBeUndefined();
      expect(capabilities.workspace).toEqual({
        read: false,
        write: false,
        exec: false,
        git: false,
        upload: false,
        download: false,
      });
      const environment = await provider.create({
        idempotencyKey: environmentId,
        profile: { name: "integration", harness: "pi" },
        workspace: { cwd: bridge.projectDir },
      });
      const reference = await environment.dispatch!({
        prompt: "prove the native interaction path",
        sessionId,
        turnId: "sdk-cli-bridge-integration-turn",
        executionId: "sdk-cli-bridge-integration-run",
        interactions: { permission: true },
      });
      const controlRef = reference.controlRef as AgentExactRunControlRef | undefined;
      if (!controlRef) throw new Error("the actual Bridge did not return an exact native control reference");

      const session = environment.session!(sessionId, { controlRef });
      const firstEvents: AgentEnvironmentEvent[] = [];
      let interaction: InteractionRequest | undefined;
      let command: InteractionResponseCommand | undefined;
      let acknowledgement: InteractionAcknowledgement | undefined;
      for await (const event of session.events({ since: "0" })) {
        firstEvents.push(event);
        if (event.normalized?.type !== "interaction") continue;
        if (interaction) throw new Error("the actual Bridge emitted more than one interaction");
        const request = event.normalized.request;
        interaction = request;
        expect(request.answerSpec.fields).toEqual([
          expect.objectContaining({ type: "select", name: "grant" }),
        ]);
        expect(request.binding).toMatchObject({
          runId: controlRef.runId,
          provider: controlRef.provider,
          environmentId: controlRef.environmentId,
          sessionId: controlRef.sessionId,
          executionId: controlRef.executionId,
          interactionId: request.id,
        });
        expect(request.requestDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
        const binding = {
          ...request.binding,
          requestDigest: request.requestDigest,
        };
        const response: InteractionResponse = {
          id: request.id,
          outcome: "accepted",
          data: { grant: ["allow_once"] },
        };
        command = {
          operationId: "sdk-cli-bridge-integration-response",
          binding,
          response,
          commandDigest: interactionResponseCommandDigest({ binding, response }),
        };
        acknowledgement = await environment.respondToInteraction!(command);
      }

      if (!interaction || !command || !acknowledgement) {
        throw new Error(
          `the actual Bridge did not produce an answerable native interaction; events=${JSON.stringify(firstEvents)}`,
        );
      }
      expect(acknowledgement).toMatchObject({
        status: "accepted",
        operationId: command.operationId,
        binding: command.binding,
        commandDigest: command.commandDigest,
      });
      expect(
        firstEvents.some((event) => event.normalized?.type === "status" && event.normalized.status === "completed"),
        "native event stream must reach completed",
      ).toBe(true);
      expect(
        requests.some((request) => request.pathname === "/v1/chat/completions"),
        "native execution must not use one-shot chat completions",
      ).toBe(false);
      expect(
        requests.some((request) => request.method === "POST" && request.pathname === "/v1/sessions"),
        "session create request",
      ).toBe(true);
      expect(
        requests.some((request) =>
          request.method === "POST" && request.pathname === `/v1/sessions/${sessionId}/turns`
        ),
        "native retained turn request",
      ).toBe(true);
      expect(
        requests.some((request) =>
          request.method === "POST" &&
          request.pathname === `/v1/runs/${controlRef.runId}/interactions/${encodeURIComponent(interaction.id)}/respond`
        ),
        "durable interaction response request",
      ).toBe(true);

      const replayed: AgentEnvironmentEvent[] = [];
      for await (const event of session.events({ since: "0" })) replayed.push(event);
      expect(replayed.map((event) => event.id)).toEqual(firstEvents.map((event) => event.id));
      expect(replayed.some((event) => event.normalized?.type === "interaction")).toBe(true);

      expect(firstEvents.length).toBeGreaterThan(1);
      const replayCursor = firstEvents[0]?.id;
      if (!replayCursor) throw new Error("the actual Bridge did not assign an event cursor");
      expect(Number(replayCursor)).toBeGreaterThan(0);
      const resumed: AgentEnvironmentEvent[] = [];
      for await (const event of session.events({ since: replayCursor })) resumed.push(event);
      expect(resumed.map((event) => event.id)).toEqual(firstEvents.slice(1).map((event) => event.id));
      expect(
        requests.filter((request) => request.pathname === `/v1/runs/${controlRef.runId}/events`).at(-1),
      ).toMatchObject({ lastEventId: replayCursor });

      await bridge.restart();

      const reconnectRequests: Array<{ method: string; url: string; lastEventId: string | null }> = [];
      const reconnectFetch: typeof fetch = async (url, init) => {
        reconnectRequests.push({
          method: init?.method ?? "GET",
          url: String(url),
          lastEventId: new Headers(init?.headers).get("last-event-id"),
        });
        return fetch(url, init);
      };
      const reconnectedProvider = createCliBridgeProvider({
        baseUrl: bridge.baseUrl,
        defaultModel: "pi/tangle-router/sdk-integration-model",
        fetch: reconnectFetch,
      });
      const reconnectedEnvironment = await reconnectedProvider.get!(environment.id);
      if (!reconnectedEnvironment) throw new Error("the actual Bridge did not retain the environment");
      const reconnectedSession = reconnectedEnvironment.session!(sessionId, { controlRef });
      expect(reconnectedSession.controlRef).toEqual(controlRef);
      await expect(reconnectedSession.status()).resolves.toBe("completed");
      const reconnectedEvents: AgentEnvironmentEvent[] = [];
      for await (const event of reconnectedSession.events({ since: replayCursor })) reconnectedEvents.push(event);
      expect(reconnectedEvents.map((event) => event.id)).toEqual(resumed.map((event) => event.id));
      expect(
        reconnectRequests.some((request) =>
          request.method === "GET" &&
          request.url.endsWith(`/v1/runs/${controlRef.runId}/events`) &&
          request.lastEventId === replayCursor
        ),
      ).toBe(true);

      const retry = await reconnectedEnvironment.respondToInteraction!(command);
      expect(retry).toEqual(acknowledgement);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nRequests:\n${JSON.stringify(requests)}\nActual Bridge output:\n${bridge.logs()}`,
      );
    } finally {
      await bridge.stop();
    }
  }, 30_000);
});

async function startActualBridge(): Promise<RunningBridge> {
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
      BRIDGE_BACKENDS: "pi",
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
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    projectDir,
    logs,
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

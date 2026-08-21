import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  NativeContextContinuationRequestSchema,
  interactionResponseCommandDigest,
  nativeContextContinuationRequestDigest,
  nativeContextContinuationTurnDigest,
  type AgentEnvironmentEvent,
  type AgentExactRunControlRef,
  type InteractionAcknowledgement,
  type InteractionRequest,
  type InteractionResponse,
  type InteractionResponseCommand,
  type NativeContextContinuationTurn,
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
        record({"kind": "command", "pid": os.getpid(), "type": "prompt", "turn": turns, "message": message.get("message")})
        send({"id": message.get("id"), "type": "response", "command": "prompt", "success": True})
        send({"type": "session", "id": "actual-bridge-pi-session"})
        send({"type": "agent_start"})
        send({"type": "turn_start"})
        if turns == 1:
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
      expect(capabilities.nativeContinuation).toEqual({
        atomicBoundary: true,
        requestIdempotency: true,
      });
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

      // The same interaction, answered again under a new operation identifier.
      // The Bridge compares the response digest, not the operation, so a
      // different answer is a conflict and an identical answer is the same
      // resolution.
      const resolvedAgain = async (
        operationId: string,
        response: InteractionResponse,
      ): Promise<InteractionAcknowledgement> => {
        const binding = command.binding;
        return environment.respondToInteraction!({
          operationId,
          binding,
          response,
          commandDigest: interactionResponseCommandDigest({ binding, response }),
        });
      };
      await expect(
        resolvedAgain("sdk-cli-bridge-integration-conflicting-response", {
          id: interaction.id,
          outcome: "accepted",
          data: { grant: ["deny"] },
        }),
      ).resolves.toMatchObject({
        status: "already_resolved_different",
        operationId: "sdk-cli-bridge-integration-conflicting-response",
        retryable: false,
      });
      await expect(
        resolvedAgain("sdk-cli-bridge-integration-identical-response", command.response),
      ).resolves.toMatchObject({
        status: "already_resolved_same",
        operationId: "sdk-cli-bridge-integration-identical-response",
      });

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

  it("answers a cancelled interaction with the cancelled acknowledgement", async () => {
    const bridge = await startActualBridge();
    try {
      const sessionId = "sdk-cli-bridge-cancelled-session";
      const provider = createCliBridgeProvider({
        baseUrl: bridge.baseUrl,
        defaultModel: "pi/tangle-router/sdk-integration-model",
      });
      const environment = await provider.create({
        idempotencyKey: "sdk-cli-bridge-cancelled-environment",
        profile: { name: "integration", harness: "pi" },
        workspace: { cwd: bridge.projectDir },
      });
      const reference = await environment.dispatch!({
        prompt: "pause on a permission this run never answers",
        sessionId,
        turnId: "sdk-cli-bridge-cancelled-turn",
        executionId: "sdk-cli-bridge-cancelled-run",
        interactions: { permission: true },
      });
      const controlRef = reference.controlRef as AgentExactRunControlRef | undefined;
      if (!controlRef) throw new Error("the actual Bridge did not return an exact native control reference");
      const session = environment.session!(sessionId, { controlRef });

      let interaction: InteractionRequest | undefined;
      for await (const event of session.events({ since: "0" })) {
        if (event.normalized?.type !== "interaction") continue;
        interaction = event.normalized.request;
        break;
      }
      if (!interaction) throw new Error("the actual Bridge did not pause on a native interaction");

      // The permission is still outstanding, so cancelling the run closes it
      // before any response can take effect.
      await session.cancel();
      await expect(session.status()).resolves.toBe("cancelled");

      const binding = { ...interaction.binding, requestDigest: interaction.requestDigest };
      const response: InteractionResponse = {
        id: interaction.id,
        outcome: "accepted",
        data: { grant: ["allow_once"] },
      };
      await expect(
        environment.respondToInteraction!({
          operationId: "sdk-cli-bridge-cancelled-response",
          binding,
          response,
          commandDigest: interactionResponseCommandDigest({ binding, response }),
        }),
      ).resolves.toMatchObject({
        status: "cancelled",
        operationId: "sdk-cli-bridge-cancelled-response",
        retryable: false,
      });
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nActual Bridge output:\n${bridge.logs()}`,
      );
    } finally {
      await bridge.stop();
    }
  }, 30_000);

  it("continues one live Pi session after a provider restart and replays the exact request", async () => {
    const bridge = await startActualBridge();
    const requests: Array<{
      method: string;
      pathname: string;
      body?: unknown;
    }> = [];
    const bridgeFetch: typeof fetch = async (url, init) => {
      let body: unknown;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body) as unknown;
        } catch {
          body = init.body;
        }
      }
      requests.push({
        method: init?.method ?? "GET",
        pathname: new URL(String(url)).pathname,
        ...(body === undefined ? {} : { body }),
      });
      return fetch(url, init);
    };

    try {
      const sessionId = "sdk-cli-bridge-native-continuation-session";
      const firstPrompt = "request permission before the first retained turn";
      const secondPrompt = "continue the same Pi session after Braid restarts";
      const providerOptions = {
        baseUrl: bridge.baseUrl,
        defaultModel: "pi/tangle-router/sdk-integration-model",
        fetch: bridgeFetch,
      };
      const provider = createCliBridgeProvider(providerOptions);
      const environment = await provider.create({
        idempotencyKey: "sdk-cli-bridge-native-continuation-environment",
        profile: { name: "native-continuation", harness: "pi" },
        workspace: { cwd: bridge.projectDir },
      });
      const reference = await environment.dispatch!({
        prompt: firstPrompt,
        sessionId,
        turnId: "sdk-cli-bridge-native-continuation-first-turn",
        executionId: "sdk-cli-bridge-native-continuation-first-run",
        interactions: { permission: true },
      });
      const initialControlRef = reference.controlRef as AgentExactRunControlRef | undefined;
      if (!initialControlRef) {
        throw new Error("the first retained turn did not return an exact control reference");
      }

      const initialSession = environment.session!(sessionId, { controlRef: initialControlRef });
      const firstEvents: AgentEnvironmentEvent[] = [];
      let firstInteractions = 0;
      for await (const event of initialSession.events({ since: "0" })) {
        firstEvents.push(event);
        if (event.normalized?.type !== "interaction") continue;
        firstInteractions += 1;
        const request = event.normalized.request;
        const binding = { ...request.binding, requestDigest: request.requestDigest };
        const response: InteractionResponse = {
          id: request.id,
          outcome: "accepted",
          data: { grant: ["allow_once"] },
        };
        const command: InteractionResponseCommand = {
          operationId: "sdk-cli-bridge-native-continuation-permission",
          binding,
          response,
          commandDigest: interactionResponseCommandDigest({ binding, response }),
        };
        await expect(environment.respondToInteraction!(command)).resolves.toMatchObject({
          status: "accepted",
          operationId: command.operationId,
          commandDigest: command.commandDigest,
        });
      }
      expect(firstInteractions).toBe(1);
      expect(
        firstEvents.some(
          (event) => event.normalized?.type === "status" && event.normalized.status === "completed",
        ),
      ).toBe(true);
      if (!initialSession.contextBoundary) {
        throw new Error("the retained Pi session did not expose a context boundary");
      }
      const boundary = await initialSession.contextBoundary();
      if (!boundary) throw new Error("the first retained Pi turn did not produce an exact boundary");
      expect(boundary).toMatchObject(initialControlRef);
      expect(boundary.boundary).toMatchObject({ kind: "revision" });

      const restartedProvider = createCliBridgeProvider(providerOptions);
      const restartedEnvironment = await restartedProvider.get!(environment.id);
      if (!restartedEnvironment) {
        throw new Error("the fresh provider could not reconstruct the retained environment");
      }
      expect(restartedEnvironment.id).toBe(environment.id);
      expect(restartedEnvironment.provider).toBe(environment.provider);
      const restartedSession = restartedEnvironment.session!(sessionId, {
        controlRef: initialControlRef,
      });
      if (!restartedSession.contextBoundary || !restartedSession.continueNative) {
        throw new Error("the reconstructed session did not expose native continuation");
      }
      await expect(restartedSession.contextBoundary()).resolves.toEqual(boundary);

      const secondTurn: NativeContextContinuationTurn = { prompt: secondPrompt };
      const continuationMaterial = {
        operationId: "sdk-cli-bridge-native-continuation-operation",
        turnDigest: nativeContextContinuationTurnDigest(secondTurn),
        run: initialControlRef,
        expectedBoundary: boundary,
      };
      const continuationRequest = NativeContextContinuationRequestSchema.parse({
        ...continuationMaterial,
        requestDigest: nativeContextContinuationRequestDigest(continuationMaterial),
      });
      const accepted = await restartedSession.continueNative(continuationRequest, {
        turn: secondTurn,
      });
      if (!("controlRef" in accepted)) {
        throw new Error(`native continuation was not accepted: ${JSON.stringify(accepted)}`);
      }
      const continuedControlRef = accepted.controlRef;
      expect(accepted.acknowledgement).toMatchObject({
        operationId: continuationRequest.operationId,
        requestDigest: continuationRequest.requestDigest,
        status: "accepted",
        historyMessagesSent: 0,
      });
      expect(accepted.result).toMatchObject({
        text: "native continuation accepted",
        success: true,
        sessionId,
        metadata: {
          runId: continuedControlRef.runId,
          executionId: continuedControlRef.executionId,
          requestDigest: continuedControlRef.requestDigest,
        },
      });
      expect(continuedControlRef).toMatchObject({
        provider: initialControlRef.provider,
        environmentId: initialControlRef.environmentId,
        sessionId: initialControlRef.sessionId,
      });
      expect(continuedControlRef.runId).not.toBe(initialControlRef.runId);
      expect(continuedControlRef.executionId).not.toBe(initialControlRef.executionId);
      expect(continuedControlRef.requestDigest).not.toBe(initialControlRef.requestDigest);
      expect(restartedSession.controlRef).toEqual(continuedControlRef);

      const controlRequestStart = requests.length;
      await expect(restartedSession.status()).resolves.toBe("completed");
      const continuedEvents: AgentEnvironmentEvent[] = [];
      for await (const event of restartedSession.events({ since: "0" })) {
        continuedEvents.push(event);
      }
      expect(
        continuedEvents.some((event) => {
          const normalized = event.normalized;
          return normalized?.type === "message.part.updated" &&
            normalized.part.type === "text" &&
            normalized.part.text.includes("native continuation accepted");
        }),
      ).toBe(true);
      expect(continuedEvents.some((event) => event.normalized?.type === "interaction")).toBe(false);
      expect(
        continuedEvents.some(
          (event) => event.normalized?.type === "status" && event.normalized.status === "completed",
        ),
      ).toBe(true);
      const continuedResult = await restartedSession.result();
      expect(continuedResult).toMatchObject({
        text: "native continuation accepted",
        success: true,
        sessionId,
        metadata: {
          runId: continuedControlRef.runId,
          executionId: continuedControlRef.executionId,
          requestDigest: continuedControlRef.requestDigest,
        },
      });
      const continuedRunPath = `/v1/runs/${encodeURIComponent(continuedControlRef.runId)}`;
      const initialRunPath = `/v1/runs/${encodeURIComponent(initialControlRef.runId)}`;
      const controlRequests = requests.slice(controlRequestStart);
      expect(
        controlRequests.some(
          (request) => request.method === "GET" && request.pathname === continuedRunPath,
        ),
      ).toBe(true);
      expect(
        controlRequests.some(
          (request) => request.method === "GET" && request.pathname === `${continuedRunPath}/events`,
        ),
      ).toBe(true);
      expect(
        controlRequests.some(
          (request) => request.pathname === initialRunPath || request.pathname === `${initialRunPath}/events`,
        ),
      ).toBe(false);

      const sessionViewResponse = await bridgeFetch(
        `${bridge.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}`,
      );
      expect(sessionViewResponse.ok).toBe(true);
      const sessionView = await sessionViewResponse.json() as {
        id?: string;
        turns?: number;
        run_id?: string;
      };
      expect(sessionView).toMatchObject({
        id: sessionId,
        turns: 2,
        run_id: continuedControlRef.runId,
      });

      const replayProvider = createCliBridgeProvider(providerOptions);
      const replayEnvironment = await replayProvider.get!(environment.id);
      if (!replayEnvironment) {
        throw new Error("the replay provider could not reconstruct the retained environment");
      }
      const replaySession = replayEnvironment.session!(sessionId, {
        controlRef: initialControlRef,
      });
      if (!replaySession.continueNative) {
        throw new Error("the replay session did not expose native continuation");
      }
      const replayed = await replaySession.continueNative(continuationRequest, {
        turn: secondTurn,
      });
      if (!("controlRef" in replayed)) {
        throw new Error(`native continuation retry was not replayed: ${JSON.stringify(replayed)}`);
      }
      expect(replayed.acknowledgement).toMatchObject({
        operationId: continuationRequest.operationId,
        requestDigest: continuationRequest.requestDigest,
        status: "replayed",
      });
      expect(replayed.result).toEqual(accepted.result);
      expect(replayed.controlRef).toEqual(continuedControlRef);
      expect(replaySession.controlRef).toEqual(continuedControlRef);
      expect(replayEnvironment.id).toBe(environment.id);

      const piTrace = bridge.readPiTrace();
      const nativeProcesses = piTrace.filter(
        (entry) => entry.kind === "process" && entry.args?.[0] === "--mode" && entry.args[1] === "rpc",
      );
      expect(nativeProcesses).toHaveLength(1);
      const promptCommands = piTrace.filter(
        (entry) => entry.kind === "command" && entry.type === "prompt",
      );
      expect(promptCommands).toEqual([
        expect.objectContaining({
          pid: nativeProcesses[0]?.pid,
          turn: 1,
          message: firstPrompt,
        }),
        expect.objectContaining({
          pid: nativeProcesses[0]?.pid,
          turn: 2,
          message: secondPrompt,
        }),
      ]);

      expect(
        requests.filter(
          (request) => request.method === "POST" && request.pathname === "/v1/sessions",
        ),
      ).toHaveLength(1);
      expect(
        requests.filter(
          (request) =>
            request.method === "POST" &&
            request.pathname === `/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
        ),
      ).toHaveLength(1);
      const continuationRequests = requests.filter(
        (request) =>
          request.method === "POST" &&
          request.pathname === `/v1/sessions/${encodeURIComponent(sessionId)}/continue`,
      );
      expect(continuationRequests).toHaveLength(2);
      expect(continuationRequests[0]?.body).toEqual({
        request: continuationRequest,
        turn: secondTurn,
      });
      expect(continuationRequests[1]?.body).toEqual(continuationRequests[0]?.body);
      expect(requests.some((request) => request.pathname === "/v1/chat/completions")).toBe(false);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nRequests:\n${JSON.stringify(requests)}\nActual Bridge output:\n${bridge.logs()}`,
      );
    } finally {
      await bridge.stop();
    }
  }, 45_000);
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

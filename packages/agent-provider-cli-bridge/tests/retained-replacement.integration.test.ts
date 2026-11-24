import type { AgentEnvironment, AgentTurnResult } from "@tangle-network/agent-interface";
import { describe, expect, it } from "vitest";
import { createCliBridgeProvider } from "@tangle-network/agent-provider-cli-bridge";
import { startActualBridge } from "./actual-bridge.js";

const actualBridge = process.env.CLI_BRIDGE_INTEGRATION_ROOT?.trim() ? describe : describe.skip;

// Agent Runtime's coordination attachment (`coordinationRuntimeAttachment`): its Authorization
// header is a secret-ref the Bridge resolves from the request's AGENT_RUNTIME_COORDINATION_TOKEN.
const COORDINATION_ALIAS = "agent-runtime-coordination";
const coordination = {
  transport: "http",
  url: "http://127.0.0.1:9/mcp",
  headers: {
    Authorization: { kind: "secret-ref", key: "AGENT_RUNTIME_COORDINATION_TOKEN", format: "bearer" },
  },
  metadata: { toolTimeoutMs: 300_000 },
} as const;
// Both values are fixed in tests/fixtures/claude-evidence.py.
const COORDINATION_BEARER = "sdk-cli-bridge-coordination-fixture";
const ABORTED_SESSION = "00000000-0000-4000-8000-000000000394";

interface SentRequest {
  readonly pathname: string;
  readonly body: Record<string, unknown>;
}

function recordingFetch(sent: SentRequest[]): typeof fetch {
  return async (url, init) => {
    if (typeof init?.body === "string") {
      sent.push({ pathname: new URL(String(url)).pathname, body: JSON.parse(init.body) });
    }
    return fetch(url, init);
  };
}

async function dispatchResult(
  environment: AgentEnvironment,
  turn: Parameters<NonNullable<AgentEnvironment["dispatch"]>>[0],
): Promise<AgentTurnResult> {
  const reference = await environment.dispatch!(turn);
  const controlRef = reference.controlRef;
  if (!controlRef) throw new Error("actual Bridge returned no control reference");
  return environment.session!(controlRef.sessionId, { controlRef }).result();
}

actualBridge("a Runtime replacement dispatched into the prior session", () => {
  // drewstone/cli-bridge#394: after a harness abort, Agent Runtime dispatches a replacement into the
  // prior session of the environment it reloads by id, and re-mounts its coordination tools in
  // turn.providerOptions.backend.runtimeAttachments (retainedDispatchMaterial). The Bridge refused
  // that request with HTTP 400 because the header key landed in its metadata.
  it("one-shot: the replacement after a SIGABRT resumes the session with the coordination attachment mounted", async () => {
    // The coordination attachment's loopback endpoint needs no host-service relay outside a jail.
    const bridge = await startActualBridge("claude", { BRIDGE_JAIL_MODE: "off" });
    const sent: SentRequest[] = [];
    try {
      const provider = createCliBridgeProvider({
        baseUrl: bridge.baseUrl,
        defaultModel: "claude-code/requested-model",
        fetch: recordingFetch(sent),
      });
      const environmentKey = "runtime:sdk-retained-replacement";
      const environment = await provider.create({
        idempotencyKey: environmentKey,
        profile: { name: "replacement", harness: "claude-code" },
        workspace: { cwd: { base: "host", path: bridge.projectDir } },
        metadata: { retainedIdempotencyKey: environmentKey },
        env: { AGENT_RUNTIME_COORDINATION_TOKEN: COORDINATION_BEARER },
        runtimeAttachments: { mcp: { [COORDINATION_ALIAS]: coordination } },
      });
      const sessionId = "sdk-retained-replacement-session";

      const aborted = await dispatchResult(environment, {
        prompt: "evidence-case:abort",
        sessionId,
        executionId: "sdk-retained-replacement-attempt-1",
        turnId: "sdk-retained-replacement-attempt-1:turn:0",
      });
      expect(aborted.success, bridge.logs()).toBe(false);
      expect(JSON.stringify(aborted), bridge.logs()).toContain("SIGABRT");

      const reloaded = await provider.get(environment.id);
      if (!reloaded) throw new Error("the creating provider did not rebuild its environment");
      const replacement = await dispatchResult(reloaded, {
        prompt: "The previous attempt failed; continue. evidence-case:mounted",
        sessionId,
        executionId: "sdk-retained-replacement-attempt-2",
        turnId: "sdk-retained-replacement-attempt-2:turn:0",
        providerOptions: {
          backend: { runtimeAttachments: { mcp: { [COORDINATION_ALIAS]: coordination } } },
        },
      });
      expect(replacement.success, `${replacement.error}\n${bridge.logs()}`).toBe(true);
      // The harness resumed the aborted native session, and the Bridge wrote the resolved bearer
      // into the MCP configuration it started the harness with.
      const report = /resumed=(\S+) mounted=(\S*)/u.exec(replacement.text);
      expect(report?.slice(1), replacement.text).toEqual([ABORTED_SESSION, `${COORDINATION_ALIAS}=bearer`]);

      const body = sent.findLast((request) => request.pathname === "/v1/chat/completions")?.body;
      expect(body?.execution_id).toBe("sdk-retained-replacement-attempt-2");
      expect(body?.metadata).toEqual({ retainedIdempotencyKey: environmentKey });
      expect(body?.runtime_attachments).toEqual({ mcp: { [COORDINATION_ALIAS]: coordination } });
    } finally {
      await bridge.stop();
    }
  }, 45_000);

  // A native retained turn mounts its attachments in the native process it starts. The Bridge
  // writes Pi's MCP configuration where the harness reads it unprotected, so it resolves no bearer
  // for Pi; this turn carries a public attachment in the same Runtime field.
  it("native retained: a turn's runtime attachment is mounted in the Pi process the turn starts", async () => {
    const bridge = await startActualBridge("pi");
    const sent: SentRequest[] = [];
    try {
      const provider = createCliBridgeProvider({
        baseUrl: bridge.baseUrl,
        defaultModel: "pi/tangle-router/sdk-integration-model",
        fetch: recordingFetch(sent),
      });
      const environment = await provider.create({
        idempotencyKey: "runtime:sdk-native-replacement",
        profile: { name: "native-replacement", harness: "pi" },
        workspace: { cwd: { base: "host", path: bridge.projectDir } },
      });
      const reloaded = await provider.get(environment.id);
      if (!reloaded) throw new Error("the creating provider did not rebuild its environment");
      const peerMail = { transport: "http", url: "https://peer-mail.invalid/mcp" } as const;
      const result = await dispatchResult(reloaded, {
        prompt: "identity-a",
        sessionId: "sdk-native-replacement-session",
        executionId: "sdk-native-replacement-attempt-2",
        turnId: "sdk-native-replacement-attempt-2:turn:0",
        providerOptions: {
          route: "native",
          backend: { runtimeAttachments: { mcp: { "agent-runtime-peer-mail": peerMail } } },
        },
      });
      expect(result.success, `${result.error}\n${bridge.logs()}`).toBe(true);
      expect(result.text).toContain("identity-a");

      expect(sent.some((request) => request.pathname === "/v1/chat/completions")).toBe(false);
      const turn = sent.find((request) => request.pathname.endsWith("/turns"))?.body;
      expect(turn?.runtime_attachments).toEqual({ mcp: { "agent-runtime-peer-mail": peerMail } });
      expect(turn?.provider_options).toEqual({ route: "native" });
      const mounted = bridge.readPiTrace().filter((entry) => entry.kind === "mcp");
      expect(mounted.map((entry) => entry.servers), bridge.logs()).toEqual([["agent-runtime-peer-mail"]]);
    } finally {
      await bridge.stop();
    }
  }, 45_000);
});

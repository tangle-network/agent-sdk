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
import { createCliBridgeProvider } from "@tangle-network/agent-provider-cli-bridge";

const BRIDGE_ROOT = process.env.CLI_BRIDGE_INTEGRATION_ROOT?.trim();
const describeActualBridge = BRIDGE_ROOT ? describe : describe.skip;

import { startActualBridge } from "./actual-bridge.js";

describeActualBridge("actual cli-bridge native interaction contract", () => {
  it("carries a canonical event stream through the real Bridge transport", async () => {
    const bridge = await startActualBridge();
    const requests: Array<{ method: string; pathname: string }> = [];
    const bridgeFetch: typeof fetch = async (url, init) => {
      requests.push({
        method: init?.method ?? "GET",
        pathname: new URL(String(url)).pathname,
      });
      return fetch(url, init);
    };

    try {
      const provider = createCliBridgeProvider({
        baseUrl: bridge.baseUrl,
        defaultModel: "pi/tangle-router/sdk-integration-model",
        fetch: bridgeFetch,
      });
      const environment = await provider.create({
        idempotencyKey: "sdk-cli-bridge-canonical-stream-environment",
        profile: { name: "canonical-stream", harness: "pi" },
        workspace: { cwd: { base: "host", path: bridge.projectDir } },
      });
      const reference = await environment.dispatch!({
        prompt: "prove the canonical stream",
        sessionId: "sdk-cli-bridge-canonical-stream-session",
        turnId: "sdk-cli-bridge-canonical-stream-turn",
        executionId: "sdk-cli-bridge-canonical-stream-run",
        interactions: { permission: true },
      });
      const controlRef = reference.controlRef as AgentExactRunControlRef | undefined;
      if (!controlRef) throw new Error("the actual Bridge did not return an exact native control reference");
      const session = environment.session!(controlRef.sessionId, { controlRef });
      const events: AgentEnvironmentEvent[] = [];
      for await (const event of session.events({ since: "0" })) {
        events.push(event);
        if (event.normalized?.type !== "interaction") continue;
        const request = event.normalized.request;
        const binding = { ...request.binding, requestDigest: request.requestDigest };
        const response: InteractionResponse = {
          id: request.id,
          outcome: "accepted",
          data: { grant: ["allow_once"] },
        };
        await environment.respondToInteraction!({
          operationId: "sdk-cli-bridge-canonical-stream-response",
          binding,
          response,
          commandDigest: interactionResponseCommandDigest({ binding, response }),
        });
      }
      expect(events.length).toBeGreaterThan(7);
      const ids = events.map((event) => event.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id) => /^\d+$/u.test(id))).toBe(true);
      const types = new Set(events.map((event) => event.normalized?.type));
      expect(types.has("interaction")).toBe(true);
      expect(types.has("plan.submitted")).toBe(true);
      expect(types.has("message.part.updated")).toBe(true);
      expect(events.some((event) => event.usage !== undefined)).toBe(true);
      expect(types.has("status")).toBe(true);
      expect(
        events.some(
          (event) =>
            event.normalized?.type === "message.part.updated" &&
            event.normalized.part.type === "tool" &&
            event.normalized.part.state.status === "completed",
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) => event.normalized?.type === "status" && event.normalized.status === "completed",
        ),
      ).toBe(true);
      expect(requests.some((request) => request.pathname === "/v1/chat/completions")).toBe(false);
    } finally {
      await bridge.stop();
    }
  }, 30_000);

  it("reattaches and replays a resolved interaction after Bridge restart", async () => {
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
      expect(capabilities.nativeContinuation).toMatchObject({
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
        cwdBases: { repository: false, host: true },
      });
      const environment = await provider.create({
        idempotencyKey: environmentId,
        profile: { name: "integration", harness: "pi" },
        workspace: { cwd: { base: "host", path: bridge.projectDir } },
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
        firstEvents.some(
          (event) =>
            event.normalized?.type === "message.part.updated" &&
            event.normalized.part.type === "reasoning",
        ),
        "native event stream must preserve reasoning",
      ).toBe(true);
      expect(
        firstEvents.some(
          (event) =>
            event.normalized?.type === "message.part.updated" &&
            event.normalized.part.type === "text",
        ),
        "native event stream must preserve text",
      ).toBe(true);
      expect(
        firstEvents.some(
          (event) =>
            event.normalized?.type === "message.part.updated" &&
            event.normalized.part.type === "tool" &&
            event.normalized.part.state.status === "completed",
        ),
        "native event stream must preserve completed tools",
      ).toBe(true);
      expect(
        firstEvents.some((event) => event.normalized?.type === "plan.submitted"),
        "native event stream must preserve plans",
      ).toBe(true);
      expect(
        firstEvents.some((event) => event.usage !== undefined),
        "native event stream must preserve usage",
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
        workspace: { cwd: { base: "host", path: bridge.projectDir } },
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

  it("isolates concurrent run identities through the real Bridge transport", async () => {
    const bridge = await startActualBridge();
    try {
      const provider = createCliBridgeProvider({
        baseUrl: bridge.baseUrl,
        defaultModel: "pi/tangle-router/sdk-integration-model",
      });
      const environment = await provider.create({
        idempotencyKey: "sdk-cli-bridge-run-identity-environment",
        profile: { name: "run-identity", harness: "pi" },
        workspace: { cwd: { base: "host", path: bridge.projectDir } },
      });
      const [referenceA, referenceB] = await Promise.all([
        environment.dispatch!({
          prompt: "emit identity-a only",
          sessionId: "sdk-cli-bridge-run-identity-session-a",
          turnId: "sdk-cli-bridge-run-identity-turn-a",
          executionId: "sdk-cli-bridge-run-identity-execution-a",
        }),
        environment.dispatch!({
          prompt: "emit identity-b only",
          sessionId: "sdk-cli-bridge-run-identity-session-b",
          turnId: "sdk-cli-bridge-run-identity-turn-b",
          executionId: "sdk-cli-bridge-run-identity-execution-b",
        }),
      ]);
      const collect = async (
        reference: typeof referenceA,
        marker: string,
      ) => {
        const controlRef = reference.controlRef as AgentExactRunControlRef | undefined;
        if (!controlRef) throw new Error("the actual Bridge did not return an exact run identity");
        const session = environment.session!(controlRef.sessionId, { controlRef });
        const events: AgentEnvironmentEvent[] = [];
        for await (const event of session.events({ since: "0" })) events.push(event);
        const result = await session.result();
        expect(result).toMatchObject({
          success: true,
          sessionId: controlRef.sessionId,
          metadata: {
            runId: controlRef.runId,
            executionId: controlRef.executionId,
          },
        });
        expect(result.text).toContain(marker);
        expect(result.text).not.toContain(marker === "identity-a" ? "identity-b" : "identity-a");
        expect(events.length).toBeGreaterThan(3);
        expect(
          events.some(
            (event) => event.normalized?.type === "status" && event.normalized.status === "completed",
          ),
        ).toBe(true);
        return controlRef;
      };
      const [controlRefA, controlRefB] = await Promise.all([
        collect(referenceA, "identity-a"),
        collect(referenceB, "identity-b"),
      ]);
      expect(controlRefA.environmentId).toBe(environment.id);
      expect(controlRefB.environmentId).toBe(environment.id);
      expect(controlRefA.sessionId).not.toBe(controlRefB.sessionId);
      expect(controlRefA.runId).not.toBe(controlRefB.runId);
      expect(controlRefA.executionId).not.toBe(controlRefB.executionId);
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
        workspace: { cwd: { base: "host", path: bridge.projectDir } },
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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { StreamEvent } from "@tangle-network/agent-interface";
import { describe, expect, it } from "vitest";
import { InteractionBroker } from "../../src/interactions/broker.js";
import {
  InteractionMcpServer,
  interactionMcpToolName,
} from "../../src/interactions/mcp-server.js";
import { brokerInteractionTools } from "../../src/interactions/tools.js";

const binding = {
  runId: "run-1",
  provider: "test-provider",
  environmentId: "environment-1",
  sessionId: "session-1",
  executionId: "execution-1",
};

type InteractionEvent = Extract<StreamEvent, { type: "interaction" }>;

async function waitForInteraction(
  events: StreamEvent[],
  index = 0,
): Promise<InteractionEvent> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const event = events.filter(
      (candidate): candidate is InteractionEvent =>
        candidate.type === "interaction",
    )[index];
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Interaction event did not arrive");
}

async function connectHttp() {
  const events: StreamEvent[] = [];
  const broker = new InteractionBroker();
  const server = new InteractionMcpServer({
    ...brokerInteractionTools(broker, {
      sessionId: "session-1",
      binding,
      emit: (event) => events.push(event),
    }),
  });
  await server.start();
  const clientTransport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return { broker, client, events, server };
}

function rawMcpHeaders(token: string, sessionId?: string) {
  return {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  };
}

async function initializeRawMcpClient(server: InteractionMcpServer) {
  const response = await fetch(server.url, {
    method: "POST",
    headers: rawMcpHeaders(server.token),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "disconnect-test", version: "1.0.0" },
      },
    }),
  });
  expect(response.status).toBe(200);
  const sessionId = response.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  await response.text();

  const initialized = await fetch(server.url, {
    method: "POST",
    headers: rawMcpHeaders(server.token, sessionId ?? undefined),
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });
  expect(initialized.status).toBe(202);
  await initialized.text();
  return sessionId as string;
}

describe("InteractionMcpServer", () => {
  it("lists only the configured tools", async () => {
    const { client, server } = await connectHttp();
    try {
      const names = (await client.listTools()).tools
        .map((tool) => tool.name)
        .sort();
      expect(names).toEqual(["ask_user", "request_permission"]);
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it("round-trips a permission through the real MCP protocol", async () => {
    const { broker, client, events, server } = await connectHttp();
    try {
      const resultPromise = client.callTool({
        name: "request_permission",
        arguments: {
          tool_name: "Bash",
          input: { command: "pnpm test" },
        },
      });
      const event = await waitForInteraction(events);
      expect(event.request.kind).toBe("permission");
      broker.respond({
        id: event.request.id,
        outcome: "accepted",
        data: { grant: ["allow_once"] },
      });
      const result = (await resultPromise) as {
        content: Array<{ text: string }>;
      };
      expect(result.content[0]?.text).toBe("ALLOWED");
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it("accepts stringified question arguments from runners", async () => {
    const { broker, client, events, server } = await connectHttp();
    try {
      const resultPromise = client.callTool({
        name: "ask_user",
        arguments: {
          questions: JSON.stringify([
            { question: "Which database?", options: ["Postgres", "SQLite"] },
          ]),
        },
      });
      const event = await waitForInteraction(events);
      broker.respondQuestion({
        id: event.request.id,
        outcome: "accepted",
        data: { q0: ["SQLite"] },
      });
      const result = (await resultPromise) as {
        content: Array<{ text: string }>;
      };
      expect(result.content[0]?.text).toBe("SQLite");
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it("serves a stateful real HTTP MCP session with bearer auth", async () => {
    const events: StreamEvent[] = [];
    const broker = new InteractionBroker();
    const server = new InteractionMcpServer({
      ...brokerInteractionTools(broker, {
        sessionId: "session-1",
        binding,
        emit: (event) => events.push(event),
      }),
    });
    await server.start();
    try {
      const unauthorized = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(unauthorized.status).toBe(401);

      const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: {
          headers: { Authorization: `Bearer ${server.token}` },
        },
      });
      const client = new Client({ name: "http-test", version: "1.0.0" });
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(2);

      const resultPromise = client.callTool({
        name: "ask_user",
        arguments: { questions: [{ question: "Which database?" }] },
      });
      const event = await waitForInteraction(events);
      broker.respondQuestion({
        id: event.request.id,
        outcome: "accepted",
        data: { q0: "DuckDB" },
      });
      const result = (await resultPromise) as {
        content: Array<{ text: string }>;
      };
      expect(result.content[0]?.text).toBe("DuckDB");
      await client.close();
    } finally {
      broker.failSession("session-1");
      await server.stop();
    }
  });

  it("builds runner-facing MCP tool names", () => {
    expect(interactionMcpToolName("tangle-interaction", "ask_user")).toBe(
      "mcp__tangle-interaction__ask_user",
    );
  });

  it("cancels broker work before the MCP server closes", async () => {
    const { broker, client, events, server } = await connectHttp();
    const resultPromise = client
      .callTool({
        name: "request_permission",
        arguments: { tool_name: "Bash", input: { command: "pnpm test" } },
      })
      .then(
        () => "resolved",
        () => "rejected",
      );
    const event = await waitForInteraction(events);

    await server.stop();
    await expect(
      Promise.race([
        resultPromise,
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("still-pending"), 1_000),
        ),
      ]),
    ).resolves.not.toBe("still-pending");
    expect(
      broker.respond({
        id: event.request.id,
        outcome: "accepted",
        data: { grant: ["allow_once"] },
      }),
    ).toBe(false);
    await client.close().catch(() => undefined);
  });

  it("cancels an exact tool call when its HTTP client disconnects", async () => {
    const events: StreamEvent[] = [];
    const broker = new InteractionBroker();
    const server = new InteractionMcpServer({
      ...brokerInteractionTools(broker, {
        sessionId: "session-1",
        binding,
        emit: (event) => events.push(event),
      }),
    });
    await server.start();
    try {
      const sessionId = await initializeRawMcpClient(server);
      const request = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "ask_user",
          arguments: { questions: [{ question: "Which database?" }] },
        },
      };
      const firstController = new AbortController();
      const firstCall = fetch(server.url, {
        method: "POST",
        headers: rawMcpHeaders(server.token, sessionId),
        body: JSON.stringify(request),
        signal: firstController.signal,
      })
        .then((response) => response.text())
        .then(
          () => "settled",
          () => "disconnected",
        );
      const firstInteraction = await waitForInteraction(events);
      firstController.abort();
      await expect(firstCall).resolves.toBe("disconnected");
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(
        broker.respondQuestion({
          id: firstInteraction.request.id,
          outcome: "accepted",
          data: { q0: "stale" },
        }),
      ).toBe(false);

      const retry = fetch(server.url, {
        method: "POST",
        headers: rawMcpHeaders(server.token, sessionId),
        body: JSON.stringify(request),
      });
      const secondInteraction = await waitForInteraction(events, 1);
      expect(secondInteraction.request.id).toBe(firstInteraction.request.id);
      expect(
        broker.respondQuestion({
          id: secondInteraction.request.id,
          outcome: "accepted",
          data: { q0: "Postgres" },
        }),
      ).toBe(true);
      expect(await (await retry).text()).toContain("Postgres");
    } finally {
      await server.stop();
    }
  });

  it("serializes concurrent starts and a stop during startup", async () => {
    const server = new InteractionMcpServer({ onStop: () => undefined });
    const firstStart = server.start();
    const secondStart = server.start();
    const stop = server.stop();

    await expect(firstStart).resolves.toBeUndefined();
    await expect(secondStart).rejects.toThrow("cannot start");
    await expect(stop).resolves.toBeUndefined();
    expect(server.port).toBe(0);
  });
});

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type EventStore,
  StreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  closeHttpServer,
  SerializedTransportLifecycle,
  waitForSettled,
} from "./lifecycle.js";
import type {
  AskUserBridge,
  PermissionPromptBridge,
  RequestPermissionBridge,
  RequestPlanBridge,
} from "./tools.js";

export const DEFAULT_INTERACTION_MCP_SERVER_NAME = "tangle-interaction";
const MAX_MCP_BODY_BYTES = 4 * 1024 * 1024;
const MAX_MCP_REPLAY_EVENTS = 1_024;

type StoredMcpEvent = {
  id: string;
  streamId: string;
  message: JSONRPCMessage;
};

class BoundedMcpEventStore implements EventStore {
  private readonly events: StoredMcpEvent[] = [];
  private sequence = 0;

  async storeEvent(
    streamId: string,
    message: JSONRPCMessage,
  ): Promise<string> {
    const id = `${streamId}:${this.sequence++}`;
    this.events.push({ id, streamId, message });
    if (this.events.length > MAX_MCP_REPLAY_EVENTS) this.events.shift();
    return id;
  }

  async getStreamIdForEventId(eventId: string): Promise<string | undefined> {
    return this.events.find((event) => event.id === eventId)?.streamId;
  }

  async replayEventsAfter(
    lastEventId: string,
    options: {
      send: (eventId: string, message: JSONRPCMessage) => Promise<void>;
    },
  ): Promise<string> {
    const index = this.events.findIndex((event) => event.id === lastEventId);
    if (index < 0) return "";
    const streamId = this.events[index]?.streamId ?? "";
    for (const event of this.events.slice(index + 1)) {
      if (event.streamId === streamId) {
        await options.send(event.id, event.message);
      }
    }
    return streamId;
  }
}

function mcpOperationId(
  serverName: string,
  toolName: string,
  sessionId: string | undefined,
  requestId: RequestId,
): string {
  return `mcp-${createHash("sha256")
    .update(`${serverName}\u0000${toolName}\u0000${sessionId ?? ""}\u0000${String(requestId)}`)
    .digest("hex")}`;
}

/** Build the full tool name that a runner uses for an MCP tool. */
export function interactionMcpToolName(
  serverName: string,
  tool: string,
): string {
  return `mcp__${serverName}__${tool}`;
}

export interface InteractionMcpServerConfig {
  serverName?: string;
  onStop: () => void | Promise<void>;
  permission?: PermissionPromptBridge;
  askUser?: AskUserBridge;
  requestPermission?: RequestPermissionBridge;
  requestPlan?: RequestPlanBridge;
}

const optionSchema = z.union([
  z.string().transform((label) => ({ label })),
  z.object({ label: z.string(), description: z.string().optional() }),
]);

const questionItemSchema = z.object({
  question: z.string(),
  options: z.array(optionSchema).optional(),
  multiSelect: z.boolean().optional(),
});

const questionsSchema = {
  // Some runners encode complex MCP arguments as a JSON string.
  questions: z.preprocess((value) => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }, z.array(questionItemSchema)),
};

/**
 * Per-execution loopback MCP server for questions, permissions, and plans.
 *
 * The server listens only on 127.0.0.1 and requires an ephemeral bearer token.
 */
export class InteractionMcpServer {
  private readonly server: McpServer;
  private readonly transport: StreamableHTTPServerTransport;
  private readonly onStop: () => void | Promise<void>;
  private readonly lifecycle = new SerializedTransportLifecycle();
  private readonly activePostRequests = new Set<Promise<void>>();
  private httpServer?: Server;
  private portValue = 0;
  readonly serverName: string;
  readonly token = randomBytes(24).toString("hex");

  constructor(config: InteractionMcpServerConfig) {
    this.serverName = config.serverName ?? DEFAULT_INTERACTION_MCP_SERVER_NAME;
    this.onStop = config.onStop;
    this.server = new McpServer(
      { name: this.serverName, version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      eventStore: new BoundedMcpEventStore(),
    });

    if (config.permission) {
      const decide = config.permission;
      this.server.registerTool(
        "permission",
        {
          title: "Permission prompt",
          description:
            "Ask the user to approve a runner tool call before it executes.",
          inputSchema: {
            tool_name: z.string(),
            input: z.record(z.string(), z.unknown()).optional(),
            tool_use_id: z.string(),
          },
        },
        async (args, extra) => {
          const result = await decide({
            tool_name: args.tool_name,
            input: args.input ?? {},
            tool_use_id: args.tool_use_id,
            signal: extra.signal,
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
          };
        },
      );
    }

    if (config.askUser) {
      const askUser = config.askUser;
      this.server.registerTool(
        "ask_user",
        {
          title: "Ask the user",
          description:
            "Ask a clarifying question when a user decision is required.",
          inputSchema: questionsSchema,
        },
        async (args, extra) => {
          const answers = await askUser({
            questions: args.questions,
            operationId: mcpOperationId(
              this.serverName,
              "ask_user",
              extra.sessionId,
              extra.requestId,
            ),
            signal: extra.signal,
          });
          const text = answers
            ? answers.map((slot) => slot.join(", ")).join("\n") || "(no answer)"
            : "No answer was provided.";
          return { content: [{ type: "text" as const, text }] };
        },
      );
    }

    if (config.requestPermission) {
      const requestPermission = config.requestPermission;
      this.server.registerTool(
        "request_permission",
        {
          title: "Request permission",
          description:
            "Ask the user to approve an action before the action starts.",
          inputSchema: {
            tool_name: z.string(),
            input: z.record(z.string(), z.unknown()).optional(),
          },
        },
        async (args, extra) => {
          const result = await requestPermission({
            tool_name: args.tool_name,
            input: args.input ?? {},
            operationId: mcpOperationId(
              this.serverName,
              "request_permission",
              extra.sessionId,
              extra.requestId,
            ),
            signal: extra.signal,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: result.allowed
                  ? "ALLOWED"
                  : `DENIED${result.message ? `: ${result.message}` : ""}`,
              },
            ],
          };
        },
      );
    }

    if (config.requestPlan) {
      const requestPlan = config.requestPlan;
      this.server.registerTool(
        "request_plan",
        {
          title: "Request plan approval",
          description:
            "Submit a complete plan for review, then end the current turn.",
          inputSchema: { plan: z.string().trim().min(1) },
        },
        async (args) => {
          const sourceToolCallId = `request-plan:${createHash("sha256")
            .update(args.plan.trim())
            .digest("hex")}`;
          const submitted = await requestPlan({
            plan: args.plan,
            sourceToolCallId,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `PLAN_SUBMITTED ${submitted.id}. End this turn now.`,
              },
            ],
          };
        },
      );
    }
  }

  get port(): number {
    return this.portValue;
  }

  get url(): string {
    return `http://127.0.0.1:${this.portValue}/mcp`;
  }

  async start(): Promise<void> {
    return this.lifecycle.start(async () => {
      await this.server.connect(this.transport);
      const httpServer = createServer((request, response) => {
        const fail = (status: number, message?: string) => {
          if (response.writableEnded) return;
          try {
            response.writeHead(status).end(message);
          } catch {
            // The connection already closed.
          }
        };

        const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        if (path !== "/mcp") {
          fail(404);
          return;
        }
        if (request.headers.authorization !== `Bearer ${this.token}`) {
          fail(401);
          return;
        }

        const handle = (body?: unknown) => {
          const handled = this.transport
            .handleRequest(request, response, body)
            .catch(() => fail(500));
          if (request.method === "POST") {
            this.activePostRequests.add(handled);
            void handled.finally(() =>
              this.activePostRequests.delete(handled),
            );
          }
          return handled;
        };

        if (request.method !== "POST") {
          void handle();
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        request.on("error", () => fail(400));
        request.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_MCP_BODY_BYTES) {
            fail(413, "payload too large");
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        request.on("end", () => {
          if (response.writableEnded) return;
          let body: unknown;
          try {
            const raw = Buffer.concat(chunks).toString("utf8");
            body = raw ? JSON.parse(raw) : undefined;
          } catch {
            fail(400, "invalid json");
            return;
          }
          void handle(body);
        });
      });

      try {
        await new Promise<void>((resolve, reject) => {
          httpServer.once("error", reject);
          httpServer.listen(0, "127.0.0.1", resolve);
        });
      } catch (error) {
        httpServer.closeAllConnections?.();
        await this.server.close().catch(() => undefined);
        throw error;
      }
      const address = httpServer.address();
      this.portValue =
        address && typeof address === "object" ? address.port : 0;
      this.httpServer = httpServer;
    });
  }

  async stop(): Promise<void> {
    return this.lifecycle.stop(async () => {
      await this.onStop();
      await waitForSettled(this.activePostRequests);
      const httpServer = this.httpServer;
      this.httpServer = undefined;
      this.portValue = 0;
      await this.server.close().catch(() => undefined);
      if (httpServer) await closeHttpServer(httpServer);
    });
  }
}

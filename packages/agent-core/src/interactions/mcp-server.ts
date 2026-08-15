import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type {
  AskUserBridge,
  PermissionPromptBridge,
  RequestPermissionBridge,
  RequestPlanBridge,
} from "./tools.js";

export const DEFAULT_INTERACTION_MCP_SERVER_NAME = "tangle-interaction";
const MAX_MCP_BODY_BYTES = 4 * 1024 * 1024;

/** Build the full tool name that a runner uses for an MCP tool. */
export function interactionMcpToolName(
  serverName: string,
  tool: string,
): string {
  return `mcp__${serverName}__${tool}`;
}

export interface InteractionMcpServerConfig {
  serverName?: string;
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
  private httpServer?: Server;
  private portValue = 0;
  readonly serverName: string;
  readonly token = randomBytes(24).toString("hex");

  constructor(config: InteractionMcpServerConfig) {
    this.serverName = config.serverName ?? DEFAULT_INTERACTION_MCP_SERVER_NAME;
    this.server = new McpServer(
      { name: this.serverName, version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
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
        async (args) => {
          const result = await decide({
            tool_name: args.tool_name,
            input: args.input ?? {},
            tool_use_id: args.tool_use_id,
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
        async (args) => {
          const answers = await askUser({ questions: args.questions });
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
        async (args) => {
          const result = await requestPermission({
            tool_name: args.tool_name,
            input: args.input ?? {},
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
    if (this.httpServer) {
      throw new Error("Interaction MCP server is already running");
    }
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

      const handle = (body?: unknown) =>
        this.transport
          .handleRequest(request, response, body)
          .catch(() => fail(500));

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
      await this.server.close().catch(() => undefined);
      throw error;
    }
    const address = httpServer.address();
    this.portValue =
      address && typeof address === "object" ? address.port : 0;
    this.httpServer = httpServer;
  }

  async stop(): Promise<void> {
    const httpServer = this.httpServer;
    this.httpServer = undefined;
    this.portValue = 0;
    if (httpServer) {
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    await this.server.close().catch(() => undefined);
  }
}

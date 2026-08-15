import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type {
  InteractionExecutionBinding,
  StreamEvent,
} from "@tangle-network/agent-interface";
import { z } from "zod";
import {
  type InteractionBroker,
  InteractionQuestionSchema,
} from "./broker.js";
import {
  type AskUserBridge,
  brokerInteractionTools,
  type RequestPermissionBridge,
} from "./tools.js";

const MAX_HTTP_BODY_BYTES = 1024 * 1024;

const permissionBodySchema = z.strictObject({
  tool_name: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional(),
});

const questionBodySchema = z.strictObject({
  questions: z.array(InteractionQuestionSchema).min(1),
});

/**
 * Loopback JSON bridge for runners with an extension API but no MCP support.
 *
 * Extensions call `/permission` or `/question`. The bridge blocks until the
 * shared broker receives an operator response.
 */
export class InteractionHttpBridge {
  readonly token = randomBytes(24).toString("hex");
  private readonly requestPermission: RequestPermissionBridge;
  private readonly askUser: AskUserBridge;
  private readonly broker: InteractionBroker;
  private readonly sessionId: string;
  private httpServer?: Server;
  private portValue = 0;

  constructor(
    broker: InteractionBroker,
    options: {
      sessionId: string;
      binding: InteractionExecutionBinding;
      timeoutMs?: number;
      emit?: (event: StreamEvent) => void;
    },
  ) {
    this.broker = broker;
    this.sessionId = options.sessionId;
    const tools = brokerInteractionTools(broker, options);
    this.requestPermission = tools.requestPermission;
    this.askUser = tools.askUser;
  }

  get port(): number {
    return this.portValue;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.portValue}`;
  }

  async start(): Promise<void> {
    if (this.httpServer) {
      throw new Error("Interaction HTTP bridge is already running");
    }
    const httpServer = createServer((request, response) => {
      const send = (status: number, body?: unknown) => {
        if (response.writableEnded) return;
        const text = body === undefined ? "" : JSON.stringify(body);
        response
          .writeHead(status, { "content-type": "application/json" })
          .end(text);
      };

      if (request.headers.authorization !== `Bearer ${this.token}`) {
        send(401);
        return;
      }
      if (request.method !== "POST") {
        send(405);
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      request.on("error", () => send(400));
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_HTTP_BODY_BYTES) {
          send(413);
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
          body = raw ? JSON.parse(raw) : {};
        } catch {
          send(400, { error: "invalid json" });
          return;
        }
        this.route(request.url ?? "", body)
          .then((result) => send(result.status, result.body))
          .catch(() => send(500, { error: "interaction bridge failed" }));
      });
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    this.portValue =
      address && typeof address === "object" ? address.port : 0;
    this.httpServer = httpServer;
  }

  async stop(): Promise<void> {
    this.broker.failSession(this.sessionId);
    const httpServer = this.httpServer;
    this.httpServer = undefined;
    this.portValue = 0;
    if (!httpServer) return;
    httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }

  private async route(
    url: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const path = new URL(url, "http://127.0.0.1").pathname.replace(/\/+$/, "");
    if (path === "/permission") {
      const parsed = permissionBodySchema.safeParse(body);
      if (!parsed.success) {
        return { status: 400, body: { error: "invalid permission request" } };
      }
      const result = await this.requestPermission({
        tool_name: parsed.data.tool_name,
        input: parsed.data.input ?? {},
      });
      return {
        status: 200,
        body: {
          allowed: result.allowed,
          ...(result.message ? { reason: result.message } : {}),
        },
      };
    }
    if (path === "/question") {
      const parsed = questionBodySchema.safeParse(body);
      if (!parsed.success) {
        return { status: 400, body: { error: "invalid question request" } };
      }
      const answers = await this.askUser({ questions: parsed.data.questions });
      return { status: 200, body: { answers } };
    }
    return { status: 404, body: { error: "unknown route" } };
  }
}

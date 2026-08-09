import type { InputPart, Part } from "./parts.js";

export type BackendMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  parts: Array<Part | InputPart | unknown>;
  timestamp: string;
  metadata?: Record<string, unknown>;
};

export type GetMessagesOptions = {
  sessionId: string;
  limit?: number;
  offset?: number;
  since?: number;
};

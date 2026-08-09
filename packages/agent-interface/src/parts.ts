/** Base fields shared by all parts. */
export type PartBase = {
  id: string;
  sessionID: string;
  messageID: string;
};

export type TextPart = PartBase & {
  type: "text";
  text: string;
};

export type ToolStatePending = {
  status: "pending";
  input: Record<string, unknown>;
  raw?: string;
};

export type ToolStateRunning = {
  status: "running";
  input: Record<string, unknown>;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: { start: number };
};

export type ToolStateCompleted = {
  status: "completed";
  input: Record<string, unknown>;
  output: unknown;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: { start: number; end: number };
};

export type ToolStateError = {
  status: "error" | "failed";
  input: Record<string, unknown>;
  error?: string;
  output?: unknown;
  metadata?: Record<string, unknown>;
  time?: { start: number; end?: number };
};

export type ToolState =
  | ToolStatePending
  | ToolStateRunning
  | ToolStateCompleted
  | ToolStateError;

export type ToolPart = PartBase & {
  type: "tool";
  callID?: string;
  tool: string;
  state: ToolState;
  metadata?: Record<string, unknown>;
};

export type ReasoningPart = PartBase & {
  type: "reasoning";
  text: string;
};

export type FilePart = PartBase & {
  type: "file";
  filename?: string;
  mediaType?: string;
  url?: string;
};

export type SubtaskPart = PartBase & {
  type: "subtask";
  prompt: string;
  description: string;
  agent: string;
};

export type Part = TextPart | ToolPart | ReasoningPart | FilePart | SubtaskPart;

export function isTextPart(part: Part): part is TextPart {
  return part.type === "text";
}

export function isToolPart(part: Part): part is ToolPart {
  return part.type === "tool";
}

export function isReasoningPart(part: Part): part is ReasoningPart {
  return part.type === "reasoning";
}

export function isFilePart(part: Part): part is FilePart {
  return part.type === "file";
}

export function isSubtaskPart(part: Part): part is SubtaskPart {
  return part.type === "subtask";
}

export type InputTextPart = {
  type: "text";
  text: string;
};

export type InputFilePart = {
  type: "file";
  filename?: string;
  mediaType?: string;
  url?: string;
  path?: string;
  content?: string;
};

export type InputImagePart = {
  type: "image";
  filename?: string;
  mediaType?: string;
  url?: string;
  path?: string;
};

export type InputPart = InputTextPart | InputFilePart | InputImagePart;

export function isInputTextPart(part: InputPart): part is InputTextPart {
  return part.type === "text";
}

export function isInputFilePart(part: InputPart): part is InputFilePart {
  return part.type === "file";
}

export function isInputImagePart(part: InputPart): part is InputImagePart {
  return part.type === "image";
}

export function normalizeInputParts(input: {
  message?: string;
  parts?: InputPart[];
}): InputPart[] {
  if (Array.isArray(input.parts) && input.parts.length > 0) {
    return input.parts;
  }
  if (typeof input.message === "string" && input.message.length > 0) {
    return [{ type: "text", text: input.message }];
  }
  return [];
}

export function renderInputPartsAsText(parts: InputPart[]): string {
  const textParts: string[] = [];
  const attachmentRefs: string[] = [];

  for (const part of parts) {
    if (part.type === "text") {
      if (part.text) textParts.push(part.text);
      continue;
    }

    const label =
      part.path ||
      part.filename ||
      part.url ||
      (part.type === "image" ? "image attachment" : "file attachment");
    attachmentRefs.push(
      `[${part.type === "image" ? "Image" : "File"}: ${label}]`,
    );
  }

  if (attachmentRefs.length === 0) {
    return textParts.join("\n\n").trim();
  }

  const text = textParts.join("\n\n").trim();
  const attachmentBlock = `Attached files:\n${attachmentRefs.join("\n")}`;
  return text ? `${text}\n\n${attachmentBlock}` : attachmentBlock;
}

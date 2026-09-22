export const AGENT_PROFILE_JSON_MAX_DEPTH = 512;
export const AGENT_PROFILE_JSON_MAX_NODES = 50_000;
export const AGENT_PROFILE_JSON_MAX_FIELDS = 4_096;
export const AGENT_PROFILE_JSON_MAX_ITEMS = 4_096;
export const AGENT_PROFILE_JSON_MAX_STRING_BYTES = 1_048_576;
export const AGENT_PROFILE_JSON_MAX_TOTAL_BYTES = 4 * 1_048_576;

export type AgentProfileJsonErrorCode =
  | "unsupported-value"
  | "invalid-number"
  | "invalid-unicode"
  | "invalid-object"
  | "unstable-object"
  | "prototype-sensitive-key"
  | "shared-reference"
  | "sparse-array"
  | "depth-limit"
  | "node-limit"
  | "field-limit"
  | "item-limit"
  | "string-limit"
  | "byte-limit";

export class AgentProfileJsonError extends Error {
  constructor(
    readonly code: AgentProfileJsonErrorCode,
    readonly path: string,
    detail: string,
  ) {
    super(`AgentProfile ${path || "root"} ${detail}`);
    this.name = "AgentProfileJsonError";
  }
}

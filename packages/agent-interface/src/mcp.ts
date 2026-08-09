export type LocalMcpConfig = {
  type: "local" | "stdio";
  command: string | string[];
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  timeout?: number;
};

export type RemoteMcpConfig = {
  type: "remote" | "http";
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  timeout?: number;
};

export type McpConfig = LocalMcpConfig | RemoteMcpConfig;

export type McpServerStatus = {
  name: string;
  status: "connected" | "disconnected" | "error" | "unknown";
  type?: "local" | "remote" | "stdio" | "http";
  error?: string;
};

export type McpStatusResponse = {
  servers: Record<string, McpServerStatus>;
};

export type BackendListOptions = {
  limit?: number;
  cursor?: string;
};

export type BackendListResult<TItem> = {
  items: TItem[];
  nextCursor?: string;
};

export type BackendArtifact = {
  path: string;
  sizeBytes?: number;
  updatedAt?: string;
};

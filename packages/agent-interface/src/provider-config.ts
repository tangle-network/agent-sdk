export type BackendCapabilities = {
  streaming: boolean;
  toolUse: boolean;
  reasoning: boolean;
  multimodal: boolean;
  contextWindow: number;
  interactions?: string[];
};

export type ProviderCapabilities = {
  supportsVision: boolean;
  supportsLogprobs: boolean;
  supportsToolCalls: boolean;
  supportsComputerUse: boolean;
};

export type CliAuthFile = {
  path: string;
  content: string;
  mode?: number;
};

export type ProviderConfig = {
  model: {
    provider?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    maxThinkingTokens?: number;
    mode?: "api" | "cli";
    authMode?: "api-key" | "oauth";
    authFiles?: CliAuthFile[];
  };
  server?: {
    port?: number;
    hostname?: string;
  };
  workspace?: {
    rootPath: string;
  };
  metadata?: Record<string, unknown>;
  profile?: Record<string, unknown>;
};

export type ModelGatewayDefaults = {
  provider: string;
  name: string;
  rootUrl: string;
  baseUrl: string;
  model: string;
  apiKeyEnvVar: string;
};

export const TANGLE_ROUTER_DEFAULT_ROOT_URL = "https://router.tangle.tools";

/**
 * Model a managed run requests when nothing else names one.
 *
 * The router answers a Tangle-funded call only when it both routes the model
 * AND holds a spend-authorizing price for it. A model that fails either test
 * answers 503, which a CLI reads as transient and retries until its own
 * timeout — so an unservable default hangs a run rather than failing it.
 * Confirm both properties against the live router before changing this id.
 */
export const TANGLE_ROUTER_DEFAULT_MODEL = "zai/glm-5.2";

export function normalizeOpenAiCompatibleBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export function resolveTangleRouterDefaults(
  env: Record<string, string | undefined> = process.env,
): ModelGatewayDefaults {
  const rootUrl = env.TANGLE_ROUTER_URL || TANGLE_ROUTER_DEFAULT_ROOT_URL;
  return {
    provider: "openai-compat",
    name: env.TANGLE_ROUTER_PROVIDER_NAME || "Tangle Router",
    rootUrl,
    baseUrl: normalizeOpenAiCompatibleBaseUrl(
      env.TANGLE_ROUTER_BASE_URL || rootUrl,
    ),
    model: env.TANGLE_ROUTER_MODEL || TANGLE_ROUTER_DEFAULT_MODEL,
    apiKeyEnvVar: env.TANGLE_ROUTER_API_KEY_ENV || "OPENCODE_MODEL_API_KEY",
  };
}

export function withModelGatewayDefaults<T extends ProviderConfig["model"]>(
  model: T,
  defaults = resolveTangleRouterDefaults(),
): T {
  return {
    ...model,
    provider: model.provider || defaults.provider,
    model: model.model || defaults.model,
    baseUrl: model.baseUrl || defaults.baseUrl,
  };
}

export type NativeWebToolPosture = {
  search?: boolean;
  fetch?: boolean;
};

const nativeWebSearchKeys = new Set(["websearch"]);
const nativeWebFetchKeys = new Set(["webfetch", "fetch"]);

export function resolveNativeWebTools(
  tools: Record<string, boolean> | undefined,
): NativeWebToolPosture {
  if (!tools) return {};
  const posture: NativeWebToolPosture = {};
  for (const [key, value] of Object.entries(tools)) {
    if (typeof value !== "boolean") continue;
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (nativeWebSearchKeys.has(normalized)) posture.search = value;
    else if (nativeWebFetchKeys.has(normalized)) posture.fetch = value;
  }
  return posture;
}

/**
 * Browser-safe Auth Exports
 *
 * This module exports only the auth classes and types that work in browser environments.
 * For server-side token operations (issueReadToken, verifyReadToken, etc.), use:
 *   import { ... } from "@tangle-network/agent-core/auth/server"
 */

// Re-export shared auth providers (eliminates duplication with index.ts)
export type { AuthProvider } from "./shared-providers.js";
export {
  CallbackAuth,
  NoAuth,
  ReadTokenAuth,
  RefreshableTokenAuth,
  StaticTokenAuth,
} from "./shared-providers.js";
// Browser-safe token utilities (no node:crypto dependency)
export {
  decodeToken,
  getTokenTTL,
  isTokenExpiringSoon,
} from "./tokens-browser.js";
// Re-export types (no crypto dependency)
export type {
  CreateSessionRequest,
  CreateSessionResponse,
  Product,
  ProductAuthInfo,
  ProductSecrets,
  ReadTokenPayload,
  SendMessageRequest,
  TokenValidationResult,
} from "./types.js";
export {
  CreateSessionRequestSchema,
  ProductSchema,
  ReadTokenPayloadSchema,
  SendMessageRequestSchema,
} from "./types.js";

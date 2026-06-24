/**
 * Channel Access Control
 *
 * Determines what channels a token can access based on its scope.
 * Used by SessionGateway to validate subscriptions and event delivery.
 *
 * Channel patterns:
 * - session:{sessionId} - Events for a specific session
 * - agent:{sessionId} - Agent events for a specific session
 * - project:{projectId} - All events for a project
 * - system - System-wide events (heartbeat, etc.)
 */

import {
  isBatchScopedToken,
  isProjectScopedToken,
  isSessionScopedToken,
} from "./tokens.js";
import type {
  BatchScopedTokenPayload,
  ProjectScopedTokenPayload,
  ReadTokenPayload,
  SessionScopedTokenPayload,
} from "./types.js";

/**
 * Result of channel access check.
 */
export interface ChannelAccessResult {
  /** Whether access is allowed */
  allowed: boolean;
  /** Reason for denial (if not allowed) */
  reason?: string;
}

/**
 * Extract session ID from a session channel pattern.
 * Returns null if not a session channel.
 */
export function extractSessionFromChannel(channel: string): string | null {
  if (channel.startsWith("session:")) {
    return channel.slice(8);
  }
  if (channel.startsWith("agent:")) {
    return channel.slice(6);
  }
  return null;
}

/**
 * Extract project ID from a project channel pattern.
 * Returns null if not a project channel.
 */
export function extractProjectFromChannel(channel: string): string | null {
  if (channel.startsWith("project:")) {
    return channel.slice(8);
  }
  return null;
}

/**
 * Check if a session-scoped token can access a channel.
 *
 * Session tokens can access:
 * - session:{their-sid}
 * - agent:{their-sid}
 * - system (always allowed)
 * - Wildcard patterns matching their session
 */
export function canSessionTokenAccessChannel(
  payload: SessionScopedTokenPayload,
  channel: string,
): ChannelAccessResult {
  // System channels are always allowed
  if (channel === "system" || channel.startsWith("system.")) {
    return { allowed: true };
  }

  // Global wildcard requires higher scope
  if (channel === "*") {
    return {
      allowed: false,
      reason: "Session-scoped tokens cannot subscribe to all channels",
    };
  }

  // Check session channel match
  const sessionId = extractSessionFromChannel(channel);
  if (sessionId !== null) {
    if (sessionId === payload.sid) {
      return { allowed: true };
    }
    // Wildcard session channels not allowed for session tokens
    if (sessionId === "*") {
      return {
        allowed: false,
        reason: "Session-scoped tokens cannot subscribe to all sessions",
      };
    }
    return {
      allowed: false,
      reason: `Token only has access to session ${payload.sid}`,
    };
  }

  // Project channels require project scope
  if (channel.startsWith("project:")) {
    return {
      allowed: false,
      reason: "Session-scoped tokens cannot access project channels",
    };
  }

  // Default: check if channel matches session pattern
  // Allow channels that don't have explicit scope (backward compatibility)
  return { allowed: true };
}

/**
 * Check if a project-scoped token can access a channel.
 *
 * Project tokens can access:
 * - project:{their-projectId}
 * - session:* (all sessions within project - requires validation by caller)
 * - agent:* (all agent events within project)
 * - system (always allowed)
 */
export function canProjectTokenAccessChannel(
  payload: ProjectScopedTokenPayload,
  channel: string,
): ChannelAccessResult {
  // System channels are always allowed
  if (channel === "system" || channel.startsWith("system.")) {
    return { allowed: true };
  }

  // Global wildcard requires batch scope or higher
  if (channel === "*") {
    return {
      allowed: false,
      reason:
        "Project-scoped tokens cannot subscribe to all channels across projects",
    };
  }

  // Project channel access
  const projectId = extractProjectFromChannel(channel);
  if (projectId !== null) {
    if (projectId === payload.projectId) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Token only has access to project ${payload.projectId}`,
    };
  }

  // Session channels - project tokens can access any session in their project
  // The actual validation that session belongs to project must be done by the caller
  // who has access to the session-to-project mapping
  if (channel.startsWith("session:") || channel.startsWith("agent:")) {
    // Wildcard session channels allowed for project tokens
    const sessionId = extractSessionFromChannel(channel);
    if (sessionId === "*") {
      return { allowed: true };
    }
    // Specific session - allowed but caller must verify session is in project
    return { allowed: true };
  }

  // Default: allow general channels (backward compatibility)
  return { allowed: true };
}

/**
 * Check if a batch-scoped token can access a channel.
 *
 * Batch tokens can access:
 * - project:{any of their projectIds}
 * - session:* (all sessions within their projects)
 * - agent:* (all agent events within their projects)
 * - system (always allowed)
 * - * (global wildcard - for organization-wide subscriptions)
 */
export function canBatchTokenAccessChannel(
  payload: BatchScopedTokenPayload,
  channel: string,
): ChannelAccessResult {
  // System channels are always allowed
  if (channel === "system" || channel.startsWith("system.")) {
    return { allowed: true };
  }

  // Global wildcard allowed for batch tokens
  if (channel === "*") {
    return { allowed: true };
  }

  // Project channel access
  const projectId = extractProjectFromChannel(channel);
  if (projectId !== null) {
    // Wildcard project access allowed
    if (projectId === "*") {
      return { allowed: true };
    }
    // Specific project must be in the list
    if (payload.projectIds.includes(projectId)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Token does not have access to project ${projectId}`,
    };
  }

  // Session/agent channels - batch tokens can access any session in their projects
  // Caller must verify session belongs to one of the token's projects
  if (channel.startsWith("session:") || channel.startsWith("agent:")) {
    return { allowed: true };
  }

  // Default: allow general channels (backward compatibility)
  return { allowed: true };
}

/**
 * Check if a token can access a channel.
 * Dispatches to scope-specific functions based on token type.
 *
 * @param payload - The token payload
 * @param channel - The channel to check access for
 * @returns Access result with allowed boolean and optional reason
 */
export function canTokenAccessChannel(
  payload: ReadTokenPayload,
  channel: string,
): ChannelAccessResult {
  // Use type guards for clean scope detection and type narrowing
  if (isSessionScopedToken(payload)) {
    return canSessionTokenAccessChannel(payload, channel);
  }

  if (isProjectScopedToken(payload)) {
    return canProjectTokenAccessChannel(payload, channel);
  }

  if (isBatchScopedToken(payload)) {
    return canBatchTokenAccessChannel(payload, channel);
  }

  // Invalid token scope
  return {
    allowed: false,
    reason: "Token has no valid scope (missing sid, projectId, or projectIds)",
  };
}

/**
 * Get the list of allowed channel patterns for a token.
 * Useful for informing clients what they can subscribe to.
 *
 * @param payload - The token payload
 * @returns Array of allowed channel patterns
 */
export function getAllowedChannelPatterns(payload: ReadTokenPayload): string[] {
  const patterns: string[] = ["system", "system.*"];

  // Use type guards for clean scope detection
  if (isSessionScopedToken(payload)) {
    patterns.push(`session:${payload.sid}`, `agent:${payload.sid}`);
    return patterns;
  }

  if (isProjectScopedToken(payload)) {
    patterns.push(
      `project:${payload.projectId}`,
      "session:*", // Within project
      "agent:*", // Within project
    );
    return patterns;
  }

  if (isBatchScopedToken(payload)) {
    patterns.push(
      "*", // Global wildcard
      "project:*", // All projects in batch
      ...payload.projectIds.map((id) => `project:${id}`),
      "session:*",
      "agent:*",
    );
    return patterns;
  }

  return patterns;
}

/**
 * Validate channel subscription request.
 * Checks multiple channels and returns aggregated result.
 *
 * @param payload - The token payload
 * @param channels - Channels to validate
 * @returns Object with allowed channels and denied channels with reasons
 */
export function validateChannelSubscription(
  payload: ReadTokenPayload,
  channels: string[],
): {
  allowed: string[];
  denied: Array<{ channel: string; reason: string }>;
} {
  const allowed: string[] = [];
  const denied: Array<{ channel: string; reason: string }> = [];

  for (const channel of channels) {
    const result = canTokenAccessChannel(payload, channel);
    if (result.allowed) {
      allowed.push(channel);
    } else {
      denied.push({ channel, reason: result.reason ?? "Access denied" });
    }
  }

  return { allowed, denied };
}

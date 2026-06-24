/**
 * Security validation for inline {@link AgentProfile} values.
 *
 * When a caller sends a full profile inline (rather than naming a curated,
 * trusted capability), the profile is author-controlled and may declare surfaces
 * that execute code OUTSIDE the agent's own reasoning — a stdio/local MCP server
 * (an arbitrary command spawned at startup) or a hook (a shell command run
 * automatically around the turn). A sandbox isolates the workload, but these
 * surfaces run unattended on the owner's behalf, so a cloud dispatcher must gate
 * them before materializing the profile.
 *
 * This validates the CANONICAL agent-interface shape (`mcp` keyed by
 * `AgentProfileMcpServer`, `hooks` keyed by `AgentProfileHookCommand[]`) — the
 * provider-neutral contract every backend translates from. The opencode-native
 * `validateProfileSecurity` (in `sdk-provider-opencode`) operates on opencode's
 * own profile shape and is a different layer; this is the one to use at the
 * application boundary where profiles are still provider-neutral.
 */

import type {
  AgentProfile,
  AgentProfileValidationIssue,
  AgentProfileValidationResult,
} from "./agent-profile.js";

/** Policy for {@link validateAgentProfileSecurity}. */
export interface AgentProfileSecurityPolicy {
  /**
   * Allow stdio/local MCP servers (a spawned local process). Off in cloud: an
   * inline profile must not start arbitrary commands at MCP init.
   */
  allowLocalMcp: boolean;
  /**
   * Allow lifecycle hooks (shell commands run automatically around the turn).
   * Off in cloud: hooks are author-controlled shell outside the agent's loop.
   */
  allowHooks: boolean;
  /**
   * Glob allowlist for REMOTE MCP hosts (http/sse `url` hostnames). A set list
   * rejects any host that matches no pattern; an empty list (`[]`) blocks ALL
   * remote MCP.
   *
   * SECURITY: `undefined` leaves remote MCP hosts UNRESTRICTED — it does NOT
   * protect against SSRF (an inline profile could point an MCP server at, e.g.,
   * `http://169.254.169.254/` cloud metadata or an internal address). When this
   * is `undefined`, the caller MUST enforce SSRF/egress controls at the network
   * layer, or set a restrictive allowlist (or `[]`) to fail closed.
   */
  allowedMcpHosts?: string[];
  /**
   * Allow `connections` (hub-managed integration grants). `undefined` leaves them
   * allowed — a connection is a legitimate inline-profile feature where the host
   * wires it. A host that does NOT support inline connection grants (e.g. a
   * surface that grants hub access through a separate, audited path) sets this
   * `false` so an inline profile cannot smuggle hub access through the profile.
   */
  allowConnections?: boolean;
}

/**
 * Default cloud policy: block the two unattended-code surfaces (local MCP,
 * hooks); leave remote MCP and everything else to the profile. Deliberately
 * narrow — it gates code execution paths, not the agent's normal tools/edits,
 * which the sandbox already isolates.
 *
 * NOTE: this default leaves `allowedMcpHosts` undefined, so REMOTE MCP hosts are
 * unrestricted — it is NOT an SSRF guard (see `allowedMcpHosts`). A surface that
 * must fail closed against arbitrary MCP egress should set `allowedMcpHosts`
 * (e.g. `[]` to block all remote MCP), as the workflow inline-profile policy does.
 */
export const DEFAULT_CLOUD_AGENT_PROFILE_SECURITY_POLICY: AgentProfileSecurityPolicy =
  {
    allowLocalMcp: false,
    allowHooks: false,
  };

/**
 * Match one DNS label against one pattern label, where `*` matches any run of
 * characters WITHIN the label (never a `.`). Split-on-`*` with linear
 * prefix/suffix/in-order scanning — deliberately NOT a constructed `RegExp`, so
 * on this security boundary it stays provably linear with no catastrophic-
 * backtracking surface whatever pattern an allowlist carries.
 */
function matchLabel(label: string, pattern: string): boolean {
  const segments = pattern.split("*");
  if (segments.length === 1) return label === segments[0]; // no wildcard
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (!label.startsWith(first) || !label.endsWith(last)) return false;
  // Prefix and suffix may not overlap (e.g. `aa*aa` must not match `aaa`).
  if (first.length + last.length > label.length) return false;
  let cursor = first.length;
  const suffixStart = label.length - last.length;
  for (let i = 1; i < segments.length - 1; i += 1) {
    const seg = segments[i];
    if (seg.length === 0) continue;
    const found = label.indexOf(seg, cursor);
    if (found === -1 || found + seg.length > suffixStart) return false;
    cursor = found + seg.length;
  }
  return true;
}

/**
 * Case-insensitive host glob (`*` only) for allowlists, matched at DNS LABEL
 * granularity: the host and pattern are split on `.` and matched label-by-label,
 * and a `*` matches within a single label only — it never crosses a `.`. So
 * `*.example.com` matches `api.example.com` but NOT `evil-example.com` (no dot
 * boundary), `a.b.example.com` (extra label), or the bare apex `example.com`
 * (missing label). This prevents a wildcard from reaching an unintended sibling
 * or deeper domain on the security boundary.
 *
 * An IPv6 host (the hostname contains `:`) is matched EXACTLY — never split or
 * globbed — since `.`-label semantics don't apply to it (and an IPv4-mapped form
 * like `::ffff:1.2.3.4` contains dots that would otherwise glob unpredictably).
 */
function matchHostGlob(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (h.includes(":") || p.includes(":")) return h === p;
  const hostLabels = h.split(".");
  const patternLabels = p.split(".");
  if (hostLabels.length !== patternLabels.length) return false;
  return patternLabels.every((label, i) => matchLabel(hostLabels[i], label));
}

/**
 * A local/stdio MCP server spawns a process; a remote one connects over the
 * network. ANY `command` makes it local — a spawnable process command is the
 * thing being gated, and it stays dangerous whatever `transport` is declared
 * alongside it (pairing `command` with `transport: "sse"`/`"http"` must not slip
 * it past as "remote"). `transport: "stdio"` is local even with no command.
 */
function isLocalMcpServer(server: {
  transport?: string;
  command?: string;
}): boolean {
  return server.command !== undefined || server.transport === "stdio";
}

/**
 * Validate an inline profile against a security policy. Returns `ok: false` with
 * `error`-level issues when the profile declares a blocked surface; warnings do
 * not fail. Pure and synchronous — safe to run at author (compile) time and
 * again at dispatch as defense in depth.
 */
export function validateAgentProfileSecurity(
  profile: AgentProfile,
  policy: AgentProfileSecurityPolicy = DEFAULT_CLOUD_AGENT_PROFILE_SECURITY_POLICY,
): AgentProfileValidationResult {
  const issues: AgentProfileValidationIssue[] = [];

  for (const [name, server] of Object.entries(profile.mcp ?? {})) {
    if (isLocalMcpServer(server)) {
      if (!policy.allowLocalMcp) {
        issues.push({
          level: "error",
          code: "BLOCKED_LOCAL_MCP",
          message: `local/stdio MCP server '${name}' is not allowed (it spawns an arbitrary process)`,
          path: `mcp.${name}`,
        });
      }
      continue;
    }
    if (policy.allowedMcpHosts) {
      // An allowlist is active, so a non-local server MUST present a matchable
      // host — a missing/empty `url` cannot be allowlist-checked, so it fails
      // closed rather than slipping through unvalidated.
      if (!server.url) {
        issues.push({
          level: "error",
          code: "INVALID_MCP_URL",
          message: `remote MCP server '${name}' has no url to check against the allowlist`,
          path: `mcp.${name}`,
        });
        continue;
      }
      let host: string;
      try {
        host = new URL(server.url).hostname;
      } catch {
        issues.push({
          level: "error",
          code: "INVALID_MCP_URL",
          message: `MCP server '${name}' has an invalid url: ${server.url}`,
          path: `mcp.${name}`,
        });
        continue;
      }
      if (!policy.allowedMcpHosts.some((p) => matchHostGlob(host, p))) {
        issues.push({
          level: "error",
          code: "BLOCKED_REMOTE_MCP_HOST",
          message: `remote MCP host '${host}' is not in the allowlist`,
          path: `mcp.${name}`,
        });
      }
    }
  }

  if (
    !policy.allowHooks &&
    profile.hooks &&
    Object.keys(profile.hooks).length > 0
  ) {
    issues.push({
      level: "error",
      code: "BLOCKED_HOOKS",
      message:
        "hooks are not allowed (they run author-controlled shell commands automatically)",
      path: "hooks",
    });
  }

  if (
    policy.allowConnections === false &&
    profile.connections &&
    profile.connections.length > 0
  ) {
    issues.push({
      level: "error",
      code: "BLOCKED_CONNECTIONS",
      message:
        "hub connections are not allowed in an inline profile here — grant hub access through this surface's supported connection path instead",
      path: "connections",
    });
  }

  return {
    ok: !issues.some((i) => i.level === "error"),
    issues,
  };
}

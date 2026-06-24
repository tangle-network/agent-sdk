/**
 * Channel Pattern Matching
 *
 * Generic utility for matching channel patterns with wildcard support.
 * Used for channel subscriptions and event filtering.
 *
 * Pattern syntax:
 * - "*" matches all channels
 * - "foo.*" matches "foo.bar", "foo.baz", etc. (dot-separated)
 * - "foo:*" matches "foo:bar", "foo:baz", etc. (colon-separated)
 * - "foo.bar" matches exactly "foo.bar"
 * - "session:abc" matches exactly "session:abc"
 */

/**
 * Check if a pattern matches a channel name.
 *
 * @param pattern - The pattern to match against (supports wildcards)
 * @param channel - The channel name to check
 * @returns true if the pattern matches the channel
 */
export function matchesChannel(pattern: string, channel: string): boolean {
  // Wildcard matches everything
  if (pattern === "*") {
    return true;
  }

  // Prefix wildcard with dot separator: "foo.*" matches "foo.bar", "foo.baz", etc.
  // Does NOT match the exact prefix (e.g., "foo.*" does NOT match "foo")
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return channel.startsWith(`${prefix}.`);
  }

  // Prefix wildcard with colon separator: "session:*" matches "session:abc", etc.
  // Used for session/project/agent channel patterns
  // Does NOT match the exact prefix (e.g., "session:*" does NOT match "session:")
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2);
    return (
      channel.startsWith(`${prefix}:`) && channel.length > prefix.length + 1
    );
  }

  // Exact match
  return pattern === channel;
}

/**
 * Check if any subscribed channel pattern matches the given channel.
 *
 * @param subscribedChannels - Set or array of channel patterns
 * @param channel - The channel to check
 * @returns true if any pattern matches the channel
 */
export function matchesAnyChannel(
  subscribedChannels: Set<string> | string[],
  channel: string,
): boolean {
  const patterns = Array.isArray(subscribedChannels)
    ? subscribedChannels
    : Array.from(subscribedChannels);

  return patterns.some((pattern) => matchesChannel(pattern, channel));
}

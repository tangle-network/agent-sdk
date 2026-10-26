/**
 * Server-Timing header parse and format (W3C Server Timing; RFC 9110 §5.6.4
 * quoted strings). Pure ECMAScript that imports nothing, so Node, browser and
 * Cloudflare Worker bundles can take this subpath without a dependency.
 */

/** One metric of a `Server-Timing` header. */
export interface ServerTimingEntry {
  name: string;
  /** Milliseconds, only when the header carried a well-formed `dur`. */
  dur?: number;
  /** `desc`, unquoted and unescaped. */
  desc?: string;
}

const TOKEN = /^[!#$%&'*+.^_`|~\w-]+$/;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const QUOTED = /^"(?:[^"\\]|\\[\s\S])*"$/;
const MAX_FORMAT_ENTRIES = 32;
const MAX_FORMAT_DESC = 120;

/** Split on `separator` outside quoted strings, skipping backslash-escaped characters inside them. */
function split(value: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quoted && char === "\\") i++;
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === separator) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

/**
 * Parse a `Server-Timing` header. Never throws. A metric with an invalid name
 * is skipped; a missing or malformed `dur` stays absent, never zero. The first
 * occurrence of a parameter wins, and repeated metrics stay separate entries.
 */
export function parseServerTiming(
  header: string | null | undefined,
): ServerTimingEntry[] {
  if (!header) return [];
  const entries: ServerTimingEntry[] = [];
  for (const metric of split(header, ",")) {
    const [rawName, ...params] = split(metric, ";");
    const name = (rawName ?? "").trim();
    if (!TOKEN.test(name)) continue;
    const entry: ServerTimingEntry = { name };
    const seen = new Set<string>();
    for (const param of params) {
      const eq = param.indexOf("=");
      const key = (eq < 0 ? param : param.slice(0, eq)).trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (eq < 0) continue;
      let value = param.slice(eq + 1).trim();
      if (value.startsWith('"')) {
        if (!QUOTED.test(value)) continue;
        value = value.slice(1, -1).replace(/\\([\s\S])/g, "$1");
      }
      if (key === "desc") entry.desc = value;
      else if (key === "dur" && NUMBER.test(value)) {
        const dur = Number(value);
        if (Number.isFinite(dur)) entry.dur = dur;
      }
    }
    entries.push(entry);
  }
  return entries;
}

/** Duration-bearing metrics by name; a later metric of the same name wins. */
export function parseServerTimingDurations(
  header: string | null | undefined,
): Record<string, number> {
  return Object.fromEntries(
    parseServerTiming(header).flatMap(({ name, dur }) =>
      dur === undefined ? [] : [[name, dur] as const],
    ),
  );
}

/**
 * Format metrics as a `Server-Timing` header value, the inverse of
 * {@link parseServerTiming}. Invalid names are skipped; `dur` rounds to 0.1 ms;
 * `desc` is escaped as an RFC 9110 quoted string. A header carries at most 32
 * metrics and each `desc` at most 120 characters.
 */
export function formatServerTiming(
  entries: readonly ServerTimingEntry[],
): string {
  return entries
    .filter((entry) => TOKEN.test(entry.name))
    .slice(0, MAX_FORMAT_ENTRIES)
    .map((entry) =>
      [
        entry.name,
        ...(entry.dur === undefined
          ? []
          : [`dur=${Math.round(entry.dur * 10) / 10}`]),
        ...(entry.desc === undefined
          ? []
          : [
              `desc="${entry.desc.slice(0, MAX_FORMAT_DESC).replace(/["\\]/g, "\\$&")}"`,
            ]),
      ].join(";"),
    )
    .join(", ");
}

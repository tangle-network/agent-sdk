/**
 * Trace and span IDENTITY: the encoding a correlatable id has to be in, and a
 * pure way to get one from an id you already have.
 *
 * OTLP ids are fixed-width bytes, and their JSON encoding is lowercase hex — 16
 * bytes (32 hex characters) for a trace, 8 bytes (16 hex characters) for a span.
 * A W3C `traceparent` header carries exactly those, so an emitter that mints a
 * readable id like `run-7::cell-a` has silently opted out of joining anything:
 * every consumer that parses a traceparent — collectors, the CLI bridge, any
 * OTel SDK — either drops the span or rejects the export, and the run and the
 * subprocess it caused can never appear in one tree. That is not a formatting
 * preference; it is the difference between one trace and two.
 *
 * So keep the human id — put it in an attribute where it stays searchable — and
 * derive the wire id from it with {@link deriveHexId}. The derivation is a pure,
 * dependency-free function of the input string, so two processes that never talk
 * to each other mint the SAME id for the same logical unit of work, which is how
 * a round emitted here joins a bridge request emitted there.
 */

/** Hex characters in a trace id: 16 bytes. */
export const TRACE_ID_HEX_LENGTH = 32;

/** Hex characters in a span id: 8 bytes. */
export const SPAN_ID_HEX_LENGTH = 16;

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const ALL_ZERO_PATTERN = /^0+$/;

/**
 * Is this a trace id a W3C `traceparent` can carry: 32 lowercase hex characters,
 * not all zero (the all-zero id is reserved as "invalid" by the spec).
 * Never throws; a non-string is simply not one.
 */
export function isW3CTraceId(value: unknown): boolean {
  return (
    typeof value === "string" &&
    TRACE_ID_PATTERN.test(value) &&
    !ALL_ZERO_PATTERN.test(value)
  );
}

/** Is this a span id a W3C `traceparent` can carry: 16 lowercase hex, not all zero. */
export function isW3CSpanId(value: unknown): boolean {
  return (
    typeof value === "string" &&
    SPAN_ID_PATTERN.test(value) &&
    !ALL_ZERO_PATTERN.test(value)
  );
}

// Four independent 32-bit lanes: distinct offset bases and distinct odd
// multipliers, so the lanes do not track each other and the 128-bit output is
// not four views of one 32-bit hash. The finalization is MurmurHash3's x86_128
// pattern — cross-lane addition, avalanche, cross-lane addition — which is what
// spreads a one-character input change across every output bit.
const BASIS_0 = 0x811c9dc5;
const BASIS_1 = 0x9e3779b9;
const BASIS_2 = 0x85ebca6b;
const BASIS_3 = 0xc2b2ae35;
const PRIME_0 = 0x01000193;
const PRIME_1 = 0x9e3779b1;
const PRIME_2 = 0x85ebca77;
const PRIME_3 = 0xc2b2ae3d;

const REPLACEMENT_CODE_POINT = 0xfffd;

/**
 * Map any string onto a valid OTLP id, deterministically.
 *
 * `bytes` is 16 for a trace id (32 hex characters) or 8 for a span id (16 hex
 * characters) — the two widths OTLP defines.
 *
 * NOT cryptographic, and deliberately so: this is an identity mapping, not a
 * commitment, and a hash with no dependencies is the only kind this package is
 * allowed to have. It is a 128-bit non-cryptographic hash over the input's UTF-8
 * bytes, so the same string yields the same id in every process, every run and
 * any language that can encode UTF-8 — which is the whole point, because the two
 * systems deriving an id for the same unit of work never speak to each other.
 *
 * The 8-byte form folds the lanes rather than truncating, so a span id is never
 * a visible prefix of the trace id derived from the same string.
 *
 * Never throws. The result is always a valid id: {@link isW3CTraceId} /
 * {@link isW3CSpanId} accept every value this returns.
 *
 * @example
 * const traceId = deriveHexId('audit-run-1', 16)
 * const spanId = deriveHexId('audit-run-1::fhenix-sealed-bid-auction.cell', 8)
 */
export function deriveHexId(input: string, bytes: 16 | 8): string {
  // Typed as `string`, but this package is imported by JavaScript too, and a
  // reader that throws is a reader that cannot be put on an ingest path.
  const text = typeof input === "string" ? input : "";

  let h0 = BASIS_0;
  let h1 = BASIS_1;
  let h2 = BASIS_2;
  let h3 = BASIS_3;
  let length = 0;

  const feed = (byte: number): void => {
    h0 = Math.imul(h0 ^ byte, PRIME_0);
    h1 = Math.imul(h1 ^ byte, PRIME_1);
    h2 = Math.imul(h2 ^ byte, PRIME_2);
    h3 = Math.imul(h3 ^ byte, PRIME_3);
    length++;
  };

  for (let index = 0; index < text.length; index++) {
    let code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        index++;
      }
    }
    // A lone surrogate has no UTF-8 encoding; the standard substitution keeps
    // the function total instead of emitting bytes no decoder would accept.
    if (code >= 0xd800 && code <= 0xdfff) code = REPLACEMENT_CODE_POINT;

    if (code < 0x80) {
      feed(code);
    } else if (code < 0x800) {
      feed(0xc0 | (code >>> 6));
      feed(0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      feed(0xe0 | (code >>> 12));
      feed(0x80 | ((code >>> 6) & 0x3f));
      feed(0x80 | (code & 0x3f));
    } else {
      feed(0xf0 | (code >>> 18));
      feed(0x80 | ((code >>> 12) & 0x3f));
      feed(0x80 | ((code >>> 6) & 0x3f));
      feed(0x80 | (code & 0x3f));
    }
  }

  // Length participates, so 'ab' and 'ab\0' cannot collide structurally.
  h0 ^= length;
  h1 ^= length;
  h2 ^= length;
  h3 ^= length;

  h0 = (h0 + h1 + h2 + h3) | 0;
  h1 = (h1 + h0) | 0;
  h2 = (h2 + h0) | 0;
  h3 = (h3 + h0) | 0;

  h0 = fmix32(h0);
  h1 = fmix32(h1);
  h2 = fmix32(h2);
  h3 = fmix32(h3);

  h0 = (h0 + h1 + h2 + h3) | 0;
  h1 = (h1 + h0) | 0;
  h2 = (h2 + h0) | 0;
  h3 = (h3 + h0) | 0;

  const hex =
    bytes === 8
      ? lane(fmix32(h0 ^ h2)) + lane(fmix32(h1 ^ h3))
      : lane(h0) + lane(h1) + lane(h2) + lane(h3);
  return ensureNonZeroId(hex);
}

/** MurmurHash3's 32-bit finalizer: the avalanche step. */
function fmix32(value: number): number {
  let h = value;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h | 0;
}

function lane(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}

/**
 * The all-zero id is reserved as "invalid", so a hash that lands on it would be
 * rejected by every W3C parser. Module-level rather than inline — no known input
 * reaches it, and a guard no test can call is a guard nobody can trust.
 */
export function ensureNonZeroId(hex: string): string {
  if (!ALL_ZERO_PATTERN.test(hex)) return hex;
  return `${hex.slice(0, -1)}1`;
}

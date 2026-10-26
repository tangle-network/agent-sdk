/**
 * `@tangle-network/agent-trace-contract/otlp`: the OTLP/HTTP JSON wire for trace
 * exports, both directions. Producers encode attributes, timestamps and the
 * export envelope here and read the collector's answer here; ingest routes and
 * flatteners decode attribute lists and whole exports here. One encoder means
 * the same attribute reaches a collector with the same value type whichever
 * producer sent it; one decoder means every reader sees the same row.
 *
 * A leaf subpath: it imports only `./ids.js`, has no dependencies and touches
 * no Node API, so a Worker, a browser bundle and a published SDK can take it
 * without taking the validator or anything else this package exports.
 */

export { toW3CSpanId, toW3CTraceId } from "./ids.js";

/** OTLP `Span.SpanKind`, as the numbers the JSON encoding carries. */
export const OTLP_SPAN_KIND = Object.freeze({
  UNSPECIFIED: 0,
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5,
} as const);

/** OTLP `Status.StatusCode`, as the numbers the JSON encoding carries. */
export const OTLP_STATUS_CODE = Object.freeze({
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const);

/** One OTLP `AnyValue`: exactly one field is set. `intValue` is a decimal string because JSON numbers cannot carry int64. */
export interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  doubleValue?: number;
  arrayValue?: { values: OtlpAnyValue[] };
  kvlistValue?: { values: OtlpKeyValue[] };
  bytesValue?: string;
}

/** One OTLP `KeyValue`. */
export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpStatus {
  code: number;
  message?: string;
}

export interface OtlpSpanEvent {
  timeUnixNano: string;
  name: string;
  attributes?: OtlpKeyValue[];
}

/** One span as an OTLP/HTTP JSON export carries it. Times are unix nanoseconds as decimal strings. */
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceState?: string;
  flags?: number;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  events?: OtlpSpanEvent[];
  status?: OtlpStatus;
}

export interface OtlpScope {
  name: string;
  version?: string;
}

export interface OtlpScopeSpans {
  scope: OtlpScope;
  spans: OtlpSpan[];
}

export interface OtlpResourceSpans {
  resource: { attributes: OtlpKeyValue[] };
  scopeSpans: OtlpScopeSpans[];
}

/** The body of `POST /v1/traces`. */
export interface OtlpTraceExport {
  resourceSpans: OtlpResourceSpans[];
}

/** What a producer can hand the encoder. */
export type OtlpAttributeInput =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly OtlpAttributeInput[]
  | { readonly [key: string]: OtlpAttributeInput };

export interface OtlpAttributeOptions {
  /** Keys whose numbers stay `doubleValue` even when whole, so a reader sees one type per key. */
  doubles?: ReadonlySet<string>;
}

const NULL_VALUE: OtlpAnyValue = Object.freeze({ stringValue: "null" });

/**
 * Encode one value as an OTLP `AnyValue`.
 *
 * - A safe integer is `intValue`; any other finite number is `doubleValue`
 *   (`double` forces it for whole numbers too).
 * - Arrays become `arrayValue` and plain objects `kvlistValue`.
 * - `null` is the string `"null"`, so a key the producer set to null stays visible.
 * - `undefined` and a non-finite number have no OTLP value: the result is
 *   `undefined`, and the attribute or kvlist entry is left out. Inside an array
 *   they become `"null"` so the other elements keep their positions.
 */
export function toOtlpAnyValue(
  value: OtlpAttributeInput,
  double = false,
): OtlpAnyValue | undefined {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return Number.isSafeInteger(value) && !double
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  if (value === null) return { ...NULL_VALUE };
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map((item: OtlpAttributeInput) => toOtlpAnyValue(item) ?? { ...NULL_VALUE }),
      },
    };
  }
  return { kvlistValue: { values: toOtlpAttributes(value as Readonly<Record<string, OtlpAttributeInput>>) } };
}

/** Encode a flat record as an OTLP `KeyValue[]`, leaving out keys with no OTLP value. */
export function toOtlpAttributes(
  record: Readonly<Record<string, OtlpAttributeInput>>,
  options: OtlpAttributeOptions = {},
): OtlpKeyValue[] {
  const out: OtlpKeyValue[] = [];
  for (const [key, input] of Object.entries(record)) {
    const value = toOtlpAnyValue(input, options.doubles?.has(key) ?? false);
    if (value !== undefined) out.push({ key, value });
  }
  return out;
}

/**
 * Epoch milliseconds as OTLP unix nanoseconds, the decimal string the protocol
 * requires. Microseconds are kept and anything finer is floored. A non-finite
 * input is `"0"`; a producer that wants another fallback passes its own clock.
 */
export function msToUnixNano(ms: number): string {
  if (!Number.isFinite(ms)) return "0";
  return (BigInt(Math.floor(ms * 1000)) * 1000n).toString();
}

/** The one-resource, one-scope export body every producer here posts. */
export function otlpTraceExport(
  resourceAttributes: OtlpKeyValue[],
  scope: OtlpScope,
  spans: OtlpSpan[],
): OtlpTraceExport {
  return { resourceSpans: [{ resource: { attributes: resourceAttributes }, scopeSpans: [{ scope, spans }] }] };
}

/**
 * The spans a 2xx export response still refused. OTLP lets a collector accept
 * a request and reject part of it through `partialSuccess.rejectedSpans`, so
 * reading only the status counts those spans as delivered. An empty or
 * non-JSON body is a full success. Never throws.
 */
export function readOtlpPartialSuccess(body: string): {
  rejectedSpans: number;
  errorMessage?: string;
} {
  let parsed: unknown;
  try {
    parsed = body.trim() ? JSON.parse(body) : undefined;
  } catch {
    return { rejectedSpans: 0 };
  }
  const partial = isRecord(parsed) ? parsed.partialSuccess : undefined;
  if (!isRecord(partial)) return { rejectedSpans: 0 };
  const raw = partial.rejectedSpans;
  // int64 is a string in OTLP JSON; some collectors send a number.
  const count = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : 0;
  if (!Number.isSafeInteger(count) || count <= 0) return { rejectedSpans: 0 };
  const message = partial.errorMessage;
  return typeof message === "string" && message
    ? { rejectedSpans: count, errorMessage: message }
    : { rejectedSpans: count };
}

/** A decoded attribute value: plain JSON. */
export type OtlpDecodedValue =
  | string
  | number
  | boolean
  | null
  | OtlpDecodedValue[]
  | { [key: string]: OtlpDecodedValue };

export interface OtlpDecodedAttributes {
  /** Each key's value; the last occurrence wins. */
  attributes: Record<string, OtlpDecodedValue>;
  /** Every value of a key that appeared more than once, in order. */
  duplicates: Record<string, OtlpDecodedValue[]>;
}

/**
 * Decode one OTLP `AnyValue` into plain JSON. Accepts the camelCase field names
 * the OTLP/HTTP JSON spec uses and the snake_case ones SDKs that serialize the
 * protobuf field names send. `intValue` becomes a number when finite and stays
 * the decimal string otherwise; arrays and kvlists decode recursively; a shape
 * this does not know is kept as JSON rather than dropped. Never throws.
 */
export function decodeOtlpAnyValue(value: unknown): OtlpDecodedValue {
  if (!isRecord(value)) return toJsonValue(value);
  const stringValue = value.stringValue ?? value.string_value;
  if (typeof stringValue === "string") return stringValue;

  const boolValue = value.boolValue ?? value.bool_value;
  if (typeof boolValue === "boolean") return boolValue;

  const doubleValue = value.doubleValue ?? value.double_value;
  if (typeof doubleValue === "number") return Number.isFinite(doubleValue) ? doubleValue : null;

  const intValue = value.intValue ?? value.int_value;
  if (intValue !== undefined) {
    const n = Number(intValue);
    return Number.isFinite(n) ? n : String(intValue);
  }

  const arrayValue = value.arrayValue ?? value.array_value;
  if (arrayValue !== undefined) {
    return isRecord(arrayValue) && Array.isArray(arrayValue.values)
      ? arrayValue.values.map(decodeOtlpAnyValue)
      : toJsonValue(arrayValue);
  }

  const kvlistValue = value.kvlistValue ?? value.kvlist_value;
  if (kvlistValue !== undefined) {
    return isRecord(kvlistValue) && Array.isArray(kvlistValue.values)
      ? decodeOtlpAttributes(kvlistValue.values).attributes
      : toJsonValue(kvlistValue);
  }

  const bytesValue = value.bytesValue ?? value.bytes_value;
  if (bytesValue !== undefined) return toJsonValue(bytesValue);

  return toJsonValue(value);
}

/** Decode an OTLP `KeyValue[]` into a record, keeping every value of a repeated key in `duplicates`. Entries without a string key are skipped. */
export function decodeOtlpAttributes(list: unknown): OtlpDecodedAttributes {
  const attributes: Record<string, OtlpDecodedValue> = {};
  const duplicates: Record<string, OtlpDecodedValue[]> = {};
  if (!Array.isArray(list)) return { attributes, duplicates };
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry.key !== "string") continue;
    const decoded = decodeOtlpAnyValue(entry.value);
    if (Object.hasOwn(attributes, entry.key)) {
      duplicates[entry.key] ??= [attributes[entry.key] ?? null];
      duplicates[entry.key]?.push(decoded);
    }
    attributes[entry.key] = decoded;
  }
  return { attributes, duplicates };
}

/** One span from an export, flattened: ids, names, codes and nanosecond times exactly as the export carried them. */
export interface OtlpFlatSpan {
  trace_id: string;
  span_id: string;
  /** `null` for a root span (absent or empty `parentSpanId`). */
  parent_span_id: string | null;
  name: string;
  /** The numeric OTLP kind; absent when the export has none. */
  kind?: number;
  /** Unix nanoseconds as the export's decimal string, never converted through a float; absent when the export has none. */
  start_time_unix_nano?: string;
  end_time_unix_nano?: string;
  /** The numeric OTLP status code; absent when the export has none. */
  status_code?: number;
  status_message?: string;
  scope_name?: string;
  scope_version?: string;
  resource_attributes: Record<string, OtlpDecodedValue>;
  span_attributes: Record<string, OtlpDecodedValue>;
  /** Resource attributes merged with span attributes; the span wins on a key clash. */
  attributes: Record<string, OtlpDecodedValue>;
  events?: Array<{ name: string; time_unix_nano?: string; attributes: Record<string, OtlpDecodedValue> }>;
}

/**
 * Flatten an OTLP trace export (`{ resourceSpans: [...] }`, one collector file
 * line) into one row per span. A span without a string `traceId` and
 * `spanId` is skipped. Never throws: a malformed export yields no rows.
 */
export function decodeOtlpTraceExport(body: unknown): OtlpFlatSpan[] {
  const rows: OtlpFlatSpan[] = [];
  for (const resourceSpans of arrayField(body, "resourceSpans")) {
    const resource = isRecord(resourceSpans) ? resourceSpans.resource : undefined;
    const resourceAttributes = decodeOtlpAttributes(isRecord(resource) ? resource.attributes : undefined).attributes;
    for (const scopeSpans of arrayField(resourceSpans, "scopeSpans")) {
      const scope: Record<string, unknown> = isRecord(scopeSpans) && isRecord(scopeSpans.scope) ? scopeSpans.scope : {};
      for (const span of arrayField(scopeSpans, "spans")) {
        if (!isRecord(span)) continue;
        const { traceId, spanId } = span;
        if (typeof traceId !== "string" || !traceId || typeof spanId !== "string" || !spanId) continue;
        const spanAttributes = decodeOtlpAttributes(span.attributes).attributes;
        const status: Record<string, unknown> = isRecord(span.status) ? span.status : {};
        const events = Array.isArray(span.events) ? span.events.filter(isRecord) : undefined;
        rows.push({
          trace_id: traceId,
          span_id: spanId,
          parent_span_id: typeof span.parentSpanId === "string" && span.parentSpanId ? span.parentSpanId : null,
          name: typeof span.name === "string" ? span.name : "",
          ...(typeof span.kind === "number" ? { kind: span.kind } : {}),
          ...optionalNano("start_time_unix_nano", span.startTimeUnixNano),
          ...optionalNano("end_time_unix_nano", span.endTimeUnixNano),
          ...(typeof status.code === "number" ? { status_code: status.code } : {}),
          ...(typeof status.message === "string" ? { status_message: status.message } : {}),
          ...(typeof scope.name === "string" ? { scope_name: scope.name } : {}),
          ...(typeof scope.version === "string" ? { scope_version: scope.version } : {}),
          resource_attributes: resourceAttributes,
          span_attributes: spanAttributes,
          attributes: { ...resourceAttributes, ...spanAttributes },
          ...(events
            ? {
                events: events.map((event) => ({
                  name: typeof event.name === "string" ? event.name : "",
                  ...optionalNano("time_unix_nano", event.timeUnixNano),
                  attributes: decodeOtlpAttributes(event.attributes).attributes,
                })),
              }
            : {}),
        });
      }
    }
  }
  return rows;
}

/** A nanosecond time kept as the export's own decimal string; a JSON number (some SDKs send one) is written back as digits. */
function optionalNano<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
  if (typeof value === "string" && /^\d+$/.test(value)) return { [key]: value } as Record<K, string>;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return { [key]: String(value) } as Record<K, string>;
  return {};
}

function arrayField(value: unknown, key: string): unknown[] {
  const field = isRecord(value) ? value[key] : undefined;
  return Array.isArray(field) ? field : [];
}

function toJsonValue(value: unknown): OtlpDecodedValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isRecord(value)) {
    const out: Record<string, OtlpDecodedValue> = {};
    for (const [key, item] of Object.entries(value)) out[key] = toJsonValue(item);
    return out;
  }
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

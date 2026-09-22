const encodedRecordKeyPattern = "^u(?:[0-9a-f]{4})*$";
const modelRecordKeyPattern =
  "^(?!__proto__$|constructor$|prototype$)[\\s\\S]*$";
const publicConfigCredentialPattern =
  "(?:\\bsk[-_][-A-Za-z0-9_]{10,}\\b|\\bgh[pousr]_[A-Za-z0-9]{12,}\\b|\\bgithub_pat_[A-Za-z0-9_]{12,}\\b|\\bAKIA[A-Z0-9]{12,}\\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\\bBearer\\s+\\S+)";
const credentialUrlPattern = "^[^:/?#]+://[^/?#]*@";
const secretNamePattern = [
  "api[_-]?key",
  "access[_-]?key",
  "private[_-]?key",
  "token",
  "secret",
  "password",
  "credentials?",
  "authorization",
  "cookie",
  "database[_-]?url",
  "dsn",
  "pat",
]
  .map(caseInsensitivePattern)
  .join("|");
const credentialQueryPattern = `[?&](?:${secretNamePattern})=`;
const secretCapableKeyPattern = `(?:^|[_-])(?:${secretNamePattern})(?:[_-]|$)`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEncodedRecordKeySchema(value: unknown): boolean {
  return isRecord(value) && value.pattern === encodedRecordKeyPattern;
}

function setOwn(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function safeRecordPropertyNames(): Record<string, unknown> {
  return {
    type: "string",
    pattern: modelRecordKeyPattern,
  };
}

/**
 * Remove Zod's internal record-key schema from a model-facing JSON Schema.
 *
 * The cleanup accepts the current propertyNames form, the patternProperties
 * form, and an inline pattern form so a Zod emitter change cannot expose an
 * internal encoding or silently widen the model contract. Open records also
 * reject prototype-sensitive keys because some JSON-schema consumers materialize
 * records on ordinary objects and would otherwise drop __proto__.
 */
export function removeModelInputSchemaArtifacts(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeModelInputSchemaArtifacts);
  }
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = {};
  let encodedRecordValueSchema: unknown;
  let hasEncodedRecordValueSchema = false;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$schema") continue;
    if (key === "propertyNames" && isEncodedRecordKeySchema(entry)) continue;
    if (key === "pattern" && entry === encodedRecordKeyPattern) continue;
    if (key === "patternProperties" && isRecord(entry)) {
      const patterns: Record<string, unknown> = {};
      for (const [pattern, schema] of Object.entries(entry)) {
        if (pattern === encodedRecordKeyPattern) {
          encodedRecordValueSchema = removeModelInputSchemaArtifacts(schema);
          hasEncodedRecordValueSchema = true;
          continue;
        }
        setOwn(patterns, pattern, removeModelInputSchemaArtifacts(schema));
      }
      if (Object.keys(patterns).length > 0) setOwn(result, key, patterns);
      continue;
    }
    setOwn(result, key, removeModelInputSchemaArtifacts(entry));
  }

  if (hasEncodedRecordValueSchema) {
    setOwn(result, "additionalProperties", encodedRecordValueSchema);
  }

  if (result.type === "object" && result.additionalProperties !== false) {
    setOwn(result, "propertyNames", safeRecordPropertyNames());
  }
  return result;
}

/** Restore refinements that JSON Schema cannot infer from Zod callbacks. */
export function applyModelInputSchemaConstraints(value: unknown): unknown {
  patchSchema(value);
  return value;
}

function patchSchema(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) patchSchema(entry);
    return;
  }
  if (!isRecord(value)) return;

  const properties = value.properties;
  if (isRecord(properties)) {
    for (const [name, schema] of Object.entries(properties)) {
      if (name === "mcp") patchMcpSchema(schema);
      if (name === "env") patchConfigRecord(schema, environmentKeyPattern());
      if (name === "headers") patchConfigRecord(schema, headerKeyPattern());
    }
  }
  patchConfigValue(value);
  for (const entry of Object.values(value)) patchSchema(entry);
}

function patchMcpSchema(value: unknown): void {
  if (!isRecord(value) || !isRecord(value.additionalProperties)) return;
  const branches = unionBranches(value.additionalProperties);
  for (const branch of branches) {
    if (!isRecord(branch) || !isRecord(branch.properties)) continue;
    const properties = branch.properties;
    const required = Array.isArray(branch.required) ? branch.required : [];
    if (required.includes("command")) {
      setOwn(properties, "command", executableSchema());
      setOwn(properties, "cwd", relativePathSchema());
      setImpossible(properties, ["url", "headers"]);
      patchConfigRecord(properties.env, environmentKeyPattern());
    } else if (required.includes("url")) {
      setOwn(properties, "url", remoteUrlSchema());
      setImpossible(properties, ["command", "args", "env", "cwd"]);
      patchConfigRecord(properties.headers, headerKeyPattern());
    } else if (
      isRecord(properties.enabled) &&
      properties.enabled.const === false
    ) {
      setImpossible(properties, [
        "transport",
        "command",
        "args",
        "env",
        "cwd",
        "url",
        "headers",
      ]);
    }
  }
}

function patchConfigRecord(value: unknown, keySchema: Record<string, unknown>): void {
  if (!isRecord(value)) return;
  setOwn(value, "propertyNames", keySchema);
  if (value.additionalProperties !== undefined) {
    patchConfigValue(value.additionalProperties);
  }
  const patternProperties = isRecord(value.patternProperties)
    ? value.patternProperties
    : {};
  setOwn(
    patternProperties,
    secretCapableKeyPattern,
    secretReferenceConfigValueSchema(),
  );
  setOwn(value, "patternProperties", patternProperties);
}

function patchConfigValue(value: unknown): void {
  if (!isRecord(value)) return;
  for (const branch of unionBranches(value)) {
    if (!isRecord(branch) || !isRecord(branch.properties)) continue;
    const kind = branch.properties.kind;
    if (isRecord(kind) && kind.const === "public") {
      setOwn(branch.properties, "value", publicConfigValueSchema());
    }
    if (isRecord(kind) && kind.const === "secret-ref") {
      setOwn(branch.properties, "key", secretReferenceSchema());
    }
  }
}

function unionBranches(value: Record<string, unknown>): unknown[] {
  const branches = value.anyOf ?? value.oneOf;
  return Array.isArray(branches) ? branches : [];
}

function publicConfigValueSchema(): Record<string, unknown> {
  return {
    type: "string",
    pattern: "^[^\\u0000-\\u001f\\u007f]*$",
    not: {
      anyOf: [
        { pattern: publicConfigCredentialPattern },
        { pattern: credentialUrlPattern },
        { pattern: credentialQueryPattern },
      ],
    },
  };
}

function secretReferenceSchema(): Record<string, unknown> {
  return {
    type: "string",
    minLength: 1,
    maxLength: 500,
    pattern: "^\\S+$",
    not: {
      anyOf: [
        { pattern: publicConfigCredentialPattern },
        { pattern: credentialUrlPattern },
        { pattern: credentialQueryPattern },
      ],
    },
  };
}

function secretReferenceConfigValueSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      kind: { type: "string", const: "secret-ref" },
      key: secretReferenceSchema(),
      format: { type: "string", enum: ["raw", "bearer"] },
    },
    required: ["kind", "key"],
    additionalProperties: false,
  };
}

function remoteUrlSchema(): Record<string, unknown> {
  return {
    type: "string",
    minLength: 1,
    pattern: "^https?://[^\\s/?#]+(?:[/?#].*)?$",
    not: {
      anyOf: [
        { pattern: credentialUrlPattern },
        { pattern: credentialQueryPattern },
        { pattern: publicConfigCredentialPattern },
      ],
    },
  };
}

function executableSchema(): Record<string, unknown> {
  return {
    type: "string",
    minLength: 1,
    pattern: "^[A-Za-z0-9._+/-]+$",
    not: {
      anyOf: [
        { pattern: "(^|/)\\.?(?:\\.|\\.\\.)?(?:/|$)" },
        {
          pattern:
            "(?:^|/)(?:[Ss][Hh]|[Bb][Aa][Ss][Hh]|[Zz][Ss][Hh]|[Ff][Ii][Ss][Hh]|[Cc][Mm][Dd](?:\\.[Ee][Xx][Ee])?|[Pp][Oo][Ww][Ee][Rr][Ss][Hh][Ee][Ll][Ll]|[Pp][Ww][Ss][Hh])$",
        },
      ],
    },
  };
}

function relativePathSchema(): Record<string, unknown> {
  return {
    type: "string",
    pattern: "^[^\\u0000-\\u001f\\u007f\\\\/]+(?:/[^\\u0000-\\u001f\\u007f\\\\/]+)*$|^\\.$",
    not: {
      anyOf: [
        { pattern: "^/" },
        { pattern: "^[A-Za-z]:" },
        { pattern: "(?:^|/)(?:\\.|\\.\\.|\\.git|\\.sidecar)(?:/|$)" },
      ],
    },
  };
}

function environmentKeyPattern(): Record<string, unknown> {
  return {
    type: "string",
    pattern: "^(?!__proto__$|constructor$|prototype$)[A-Za-z_][A-Za-z0-9_]*$",
  };
}

function headerKeyPattern(): Record<string, unknown> {
  return {
    type: "string",
    pattern:
      "^(?!__proto__$|constructor$|prototype$)[!#$%&'*+\\-.^_`|~0-9A-Za-z]+$",
  };
}

function caseInsensitivePattern(value: string): string {
  return value.replace(/[A-Za-z]/gu, (letter) => {
    const upper = letter.toUpperCase();
    const lower = letter.toLowerCase();
    return `[${upper}${lower}]`;
  });
}

function setImpossible(
  properties: Record<string, unknown>,
  names: readonly string[],
): void {
  for (const name of names) setOwn(properties, name, false);
}

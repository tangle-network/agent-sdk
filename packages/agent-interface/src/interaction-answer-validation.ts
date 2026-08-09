import {
  InteractionAnswerSpecSchema,
  type InteractionAnswerSpec,
} from "./interaction-fields.js";
import type { InteractionData } from "./interaction-data.js";
import {
  boundedIdentifierSchema,
  CONTRACT_MAX_ARRAY_LENGTH,
  CONTRACT_MAX_MAP_ENTRIES,
  CONTRACT_MAX_STRING_LENGTH,
} from "./contract-limits.js";

export type InteractionValidation = { ok: true } | { ok: false; errors: string[] };

/**
 * Validate an accepted answer against its spec. Used by the broker before a
 * response reaches the adapter, so malformed answers are rejected centrally.
 */
export function validateInteractionAnswer(
  spec: InteractionAnswerSpec,
  data: InteractionData | undefined,
): InteractionValidation {
  const errors: string[] = [];
  const parsedSpec = InteractionAnswerSpecSchema.safeParse(spec);
  if (!parsedSpec.success) {
    return {
      ok: false,
      errors: parsedSpec.error.issues.map((issue) => issue.message),
    };
  }
  if (
    data !== undefined &&
    (!data || typeof data !== "object" || Array.isArray(data))
  ) {
    return { ok: false, errors: ["interaction data must be an object"] };
  }
  const d = data ?? (Object.create(null) as InteractionData);
  const prototype = Object.getPrototypeOf(d);
  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false, errors: ["interaction data must be a plain object"] };
  }
  if (Object.keys(d).length > CONTRACT_MAX_MAP_ENTRIES) {
    return { ok: false, errors: ["interaction data has too many fields"] };
  }
  const exactSpec = parsedSpec.data;
  const knownFields = new Set(exactSpec.fields.map((field) => field.name));
  for (const fieldName of Object.keys(d)) {
    if (fieldName.length > 512) {
      errors.push(`unknown field "${fieldName}"`);
      continue;
    }
    const rawValue = d[fieldName];
    if (typeof rawValue === "string" && rawValue.length > CONTRACT_MAX_STRING_LENGTH) {
      errors.push(`field "${fieldName}" exceeds the contract string bound`);
    } else if (Array.isArray(rawValue)) {
      if (rawValue.length > CONTRACT_MAX_ARRAY_LENGTH) {
        errors.push(`field "${fieldName}" has too many values`);
      }
      for (const entry of rawValue) {
        if (typeof entry !== "string" || entry.length > CONTRACT_MAX_STRING_LENGTH) {
          errors.push(`field "${fieldName}" contains an invalid bounded value`);
          break;
        }
      }
    } else if (rawValue && typeof rawValue === "object") {
      const valuePrototype = Object.getPrototypeOf(rawValue);
      if (
        (valuePrototype !== Object.prototype && valuePrototype !== null) ||
        Object.keys(rawValue).length > 3
      ) {
        errors.push(`field "${fieldName}" contains an invalid object value`);
      }
    }
    if (!knownFields.has(fieldName)) {
      errors.push(`unknown field "${fieldName}"`);
    }
  }
  for (const field of exactSpec.fields) {
    const hasValue = Object.hasOwn(d, field.name);
    const v = hasValue ? d[field.name] : undefined;
    const present = hasValue && v !== undefined && v !== null && !(typeof v === "string" && v === "");
    if (!present) {
      if (field.required) errors.push(`missing required field "${field.name}"`);
      continue;
    }
    switch (field.type) {
      case "text":
        if (typeof v !== "string") {
          errors.push(`field "${field.name}" must be a string`);
        } else if (field.maxLength !== undefined && v.length > field.maxLength) {
          errors.push(`field "${field.name}" exceeds maxLength ${field.maxLength}`);
        }
        break;
      case "secret": {
        const isHandle =
          typeof v === "object" &&
          v !== null &&
          !Array.isArray(v) &&
          Object.keys(v).length === 3 &&
          (Object.getPrototypeOf(v) === Object.prototype ||
            Object.getPrototypeOf(v) === null) &&
          Object.hasOwn(v, "kind") &&
          Object.hasOwn(v, "handleId") &&
          Object.hasOwn(v, "oneUse") &&
          (v as { kind?: unknown }).kind === "secret_handle" &&
          (v as { oneUse?: unknown }).oneUse === true &&
          boundedIdentifierSchema.safeParse((v as { handleId?: unknown }).handleId)
            .success;
        if (typeof v !== "string" && !isHandle) {
          errors.push(`field "${field.name}" must be a string or one-use secret handle`);
        } else if (
          typeof v === "string" &&
          field.maxLength !== undefined &&
          v.length > field.maxLength
        ) {
          errors.push(`field "${field.name}" exceeds maxLength ${field.maxLength}`);
        }
        break;
      }
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) {
          errors.push(`field "${field.name}" must be a finite number`);
        } else {
          if (field.min !== undefined && v < field.min) errors.push(`field "${field.name}" below min ${field.min}`);
          if (field.max !== undefined && v > field.max) errors.push(`field "${field.name}" above max ${field.max}`);
        }
        break;
      case "boolean":
        if (typeof v !== "boolean") errors.push(`field "${field.name}" must be a boolean`);
        break;
      case "select": {
        if (!Array.isArray(v)) {
          errors.push(`field "${field.name}" must be an array of option values`);
          break;
        }
        if (v.length > CONTRACT_MAX_ARRAY_LENGTH) {
          errors.push(`field "${field.name}" has too many option values`);
          break;
        }
        if (!field.multi && v.length > 1) errors.push(`field "${field.name}" accepts a single value`);
        if (field.required && v.length === 0) errors.push(`field "${field.name}" requires a selection`);
        const allowed = new Set(field.options.map((o) => o.value));
        for (const choice of v) {
          if (allowed.has(choice)) continue;
          if (field.allowCustom === true) {
            // Write-ins are open but stay fail-closed on shape: string, non-blank.
            if (typeof choice !== "string" || choice.trim() === "") {
              errors.push(`field "${field.name}" has blank write-in value`);
            }
            continue;
          }
          errors.push(`field "${field.name}" has invalid option "${choice}"`);
        }
        break;
      }
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

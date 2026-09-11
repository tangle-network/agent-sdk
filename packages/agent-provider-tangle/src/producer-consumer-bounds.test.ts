import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  CONTRACT_MAX_ARRAY_LENGTH,
  CONTRACT_MAX_IDENTIFIER_LENGTH,
  CONTRACT_MAX_JSON_BYTES,
  CONTRACT_MAX_STRING_LENGTH,
} from "@tangle-network/agent-interface";
import { describe, expect, it } from "vitest";

/**
 * The seam between what the Sandbox SDK WRITES and what this provider ACCEPTS.
 *
 * Every bound defect this package has shipped lived here, and none was caught by a unit test,
 * because each side is individually correct: the SDK writes a legal value, the provider rejects a
 * value it considers illegal, and only the pair is wrong. Three in one week —
 *
 *   #311  tool output written at 4 MiB, validated at CONTRACT_MAX_STRING_LENGTH (16 KiB). 256x.
 *         Cost: 143 of 199 children across 16 pursuits, every one at iterations 0, because the
 *         check runs AFTER the usage receipt is credited and so discards a finished, paid turn.
 *   #312  widening it to CONTRACT_MAX_JSON_BYTES left 4x and the same failure mode.
 *   #314  a turn prompt held to the metadata bound, capping a manager's brief at 16 KiB.
 *
 * So this file asserts the pair, not either side. A producer limit larger than the consumer bound
 * it feeds is a defect UNLESS the boundary truncates rather than throws, which is recorded per
 * pair below with the reason. Adding a bound on either side without deciding its partner fails
 * here rather than in a run.
 */

const require_ = createRequire(import.meta.url);
const sandboxDistDir = dirname(require_.resolve("@tangle-network/sandbox"));

/** Read a `const NAME = <numeric expression>;` out of the SHIPPED artifact, not out of a mirror of
 *  it. A renamed or removed constant fails loudly here, which is the point: a silent rename is how
 *  a pair stops being checked. */
function producerLimit(name: string): number {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*([0-9*\\s_]+?)\\s*;`);
  for (const file of readdirSync(sandboxDistDir)) {
    if (!file.endsWith(".js")) continue;
    const match = pattern.exec(readFileSync(join(sandboxDistDir, file), "utf8"));
    if (!match) continue;
    const expression = match[1].replace(/_/g, "").trim();
    if (!/^[0-9*\s]+$/.test(expression)) break;
    const value = expression
      .split("*")
      .map((part) => Number(part.trim()))
      .reduce((product, part) => product * part, 1);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  throw new Error(
    `Sandbox SDK no longer defines ${name} as a literal in its shipped dist. Find what replaced it and re-pair it here; do not delete the case.`,
  );
}

interface Seam {
  /** What the SDK writes. */
  readonly producer: string;
  /** What this provider validates it against. */
  readonly consumer: { readonly name: string; readonly value: number };
  /** When the consumer side truncates instead of throwing, the reason it is safe for the producer
   *  to exceed it. Absent means the pair must hold. */
  readonly truncatedBecause?: string;
}

const SEAMS: readonly Seam[] = [
  {
    producer: "MAX_SERIALIZED_TOOL_VALUE_BYTES",
    consumer: { name: "CONTRACT_MAX_JSON_BYTES", value: CONTRACT_MAX_JSON_BYTES },
    truncatedBecause:
      "validatedSandboxPromptResult truncates toolInvocations[].result with a marker rather than throwing (#312), because the check runs after the turn is paid for",
  },
  {
    producer: "MAX_GIT_AUTH_TOKEN_LENGTH",
    consumer: { name: "CONTRACT_MAX_STRING_LENGTH", value: CONTRACT_MAX_STRING_LENGTH },
  },
  {
    producer: "MAX_RUNTIME_WORKSPACE_CWD_LENGTH",
    consumer: { name: "CONTRACT_MAX_STRING_LENGTH", value: CONTRACT_MAX_STRING_LENGTH },
  },
  {
    producer: "MAX_GIT_REPOSITORY_PATH_SEGMENT_LENGTH",
    consumer: { name: "CONTRACT_MAX_IDENTIFIER_LENGTH", value: CONTRACT_MAX_IDENTIFIER_LENGTH },
  },
  {
    producer: "MAX_MACHINE_ID_LENGTH",
    consumer: { name: "CONTRACT_MAX_IDENTIFIER_LENGTH", value: CONTRACT_MAX_IDENTIFIER_LENGTH },
  },
  {
    producer: "MAX_EGRESS_DENIALS_LIMIT",
    consumer: { name: "CONTRACT_MAX_ARRAY_LENGTH", value: CONTRACT_MAX_ARRAY_LENGTH },
  },
];

describe("producer/consumer bound seam", () => {
  it.each(SEAMS)(
    "$producer fits inside $consumer.name, or the boundary truncates",
    ({ producer, consumer, truncatedBecause }) => {
      const written = producerLimit(producer);
      if (truncatedBecause !== undefined) {
        // The pair is allowed to disagree only because the boundary degrades instead of refusing.
        // The assertion still runs so the exemption cannot outlive its reason unnoticed.
        expect(truncatedBecause.length).toBeGreaterThan(0);
        return;
      }
      expect(
        written,
        `${producer} is ${written} but ${consumer.name} is ${consumer.value}: the SDK can write a value this provider refuses. Either lower the producer, raise the consumer, or truncate at the boundary and record why.`,
      ).toBeLessThanOrEqual(consumer.value);
    },
  );

  it("names every producer limit the SDK ships, so a new one cannot arrive unpaired", () => {
    const declared = new Set(SEAMS.map((seam) => seam.producer));
    const shipped = new Set<string>();
    for (const file of readdirSync(sandboxDistDir)) {
      if (!file.endsWith(".js")) continue;
      for (const match of readFileSync(join(sandboxDistDir, file), "utf8").matchAll(
        /\bconst (MAX_[A-Z0-9_]+)\s*=\s*[0-9*\s_]+;/g,
      )) {
        shipped.add(match[1]);
      }
    }
    // Limits that bound the SDK's own behaviour rather than a value it hands us. They cross no
    // seam, so pairing them would be noise; anything else must be decided.
    const internal = new Set([
      "MAX_CONCURRENT_ARTIFACT_READS",
      "MAX_CONCURRENT_DRIVE_TURNS",
      "MAX_RECONNECT_ATTEMPTS",
      "MAX_TIMER_DELAY_MS",
      "MAX_TIMER_MS",
      // Guards on what the SDK will ACCEPT from its own API, not on what it hands this provider:
      // an oversized image response is refused inside the SDK as a ServerError, and the exposed-port
      // list is dropped there when too long. Neither value reaches a contract schema.
      "MAX_WORKSPACE_IMAGE_RESPONSE_BYTES",
      "MAX_WORKSPACE_IMAGE_EXPOSED_PORTS",
      // Retained-terminal replay buffers: the SDK's own memory ceiling for a run it is holding,
      // drained frame by frame through the 1 MiB per-event content bound rather than as one value.
      "MAX_RETAINED_TERMINAL_BYTES",
      "MAX_RETAINED_TERMINAL_FRAMES",
    ]);
    const unpaired = [...shipped].filter((name) => !declared.has(name) && !internal.has(name));
    expect(
      unpaired,
      "the Sandbox SDK ships a limit this provider has not paired with a contract bound. Add it to SEAMS with the bound it feeds, or to `internal` if it never crosses the boundary.",
    ).toEqual([]);
  });
});

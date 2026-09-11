import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// A NAMESPACE import on purpose. A named import of a constant that an older resolution does not
// export fails at module link time with a SyntaxError that names the missing binding and nothing
// else — no package, no version, no reason. This file exists to diagnose exactly that resolution,
// so it has to survive one long enough to say what is wrong with it.
import * as agentInterface from "@tangle-network/agent-interface";
import { describe, expect, it } from "vitest";
import { promptFromTurnInput } from "./tangle-prompt.js";

/**
 * This package is the code that VALIDATES a turn, so the agent-interface copy it resolves decides
 * what a turn may contain — not the copy the consumer installed at its own top level.
 *
 * agent-interface 2.7.0 (agent-sdk#314) moved every `prompt` field off the 16 KiB metadata bound
 * (`CONTRACT_MAX_STRING_LENGTH`) onto the 1 MiB content bound, and 2.8.0 (#315) made the contract
 * bound constants public. This package kept declaring `^2.6.1`, which admits both older versions.
 *
 * Measured 2026-09-11: a consumer whose lockfile already held 2.6.1 for this package, and which
 * then raised its own top-level agent-interface to 2.8.0, ended up with TWO copies — agent-runtime
 * on 2.8.0, this provider on 2.6.1. Because this provider is what validates, children kept dying on
 * the 16 KiB bound with a ZodError at `path: ["prompt"]` on a stack whose package.json said the bug
 * was fixed: 14 of 34 children of one run and 8 of 52 of another, every one at iterations 0,
 * surfaced as "retained provider execution requires reconciliation before replacement".
 *
 * `producer-consumer-bounds.test.ts` cannot see this. It reads the shipped Sandbox dist and
 * compares it against contract constants it imports, and the workspace pins
 * `overrides["@tangle-network/agent-interface"]: workspace:*`, so inside this repo it always links
 * the workspace copy. This file checks the other half: which agent-interface this package would
 * resolve, and what that resolution actually accepts.
 */

/**
 * The agent-interface version this package's own validation needs.
 *
 * 2.7.0 is where a prompt stopped being metadata. 2.8.0 is where CONTRACT_MAX_ARRAY_LENGTH,
 * CONTRACT_MAX_IDENTIFIER_LENGTH and CONTRACT_MAX_STRING_LENGTH became public, which is what lets
 * this package assert its own bounds at all. Both are load-bearing here, so the floor is the later
 * one. A range that admits less than this is the defect, and it is invisible in a workspace that
 * overrides the resolution, so it is asserted rather than left to review.
 */
const REQUIRED_INTERFACE_FLOOR = "2.8.0";

/** The metadata bound's value, written out because a resolution old enough to fail this file is
 *  also too old to export the constant. One case below asserts the two agree. */
const METADATA_BOUND = 16_384;

interface Manifest {
  readonly version?: string;
  readonly dependencies?: Record<string, string>;
}

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const selfManifest = readManifest(join(packageRoot, "package.json"));

/**
 * The agent-interface copy this package's imports bind to.
 *
 * `require.resolve("@tangle-network/agent-interface/package.json")` cannot be used: that package's
 * `exports` map declares no "./package.json" subpath and no `require` condition, so Node refuses
 * both the subpath and the entry point from CommonJS. Walk the `node_modules` chain the way Node
 * locates the package directory for a bare specifier, which finds the copy that would be loaded.
 */
function resolvedInterfaceVersion(): string {
  let directory = packageRoot;
  for (;;) {
    const candidate = join(
      directory,
      "node_modules",
      "@tangle-network",
      "agent-interface",
      "package.json",
    );
    if (existsSync(candidate)) {
      const manifest = readManifest(candidate);
      if (typeof manifest.version !== "string") {
        throw new Error(`${candidate} declares no version`);
      }
      return manifest.version;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(
    "no @tangle-network/agent-interface is installed for this package. Find what changed in its packaging or install; do not delete this check.",
  );
}

/** `^X.Y.Z` only. Any other shape is refused rather than guessed at, so a range this check cannot
 *  reason about fails here instead of passing silently. */
function declaredFloor(range: string | undefined): string {
  const match = /^\^(\d+\.\d+\.\d+)$/.exec(range ?? "");
  if (match === null) {
    throw new Error(
      `agent-provider-tangle declares ${JSON.stringify(range)} for @tangle-network/agent-interface. This check only reasons about a caret range; teach it the new shape rather than removing it.`,
    );
  }
  return match[1];
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

describe("the agent-interface resolution this provider validates with", () => {
  // Behaviour first: the declared range can be right while the code behind it is not.
  it("accepts a turn prompt larger than the metadata bound", () => {
    const prompt = "x".repeat(METADATA_BOUND + 1);
    expect(
      () => promptFromTurnInput({ prompt }),
      `the resolved @tangle-network/agent-interface (${resolvedInterfaceVersion()}) still holds a turn prompt to the ${METADATA_BOUND}-character metadata bound. Every oversized turn this provider validates dies at iterations 0 (agent-sdk#314).`,
    ).not.toThrow();
    expect(promptFromTurnInput({ prompt })).toBe(prompt);
  });

  it("does not refuse an interactive prompt for its length", () => {
    // The digest and the session coordinates are deliberately unmatched, so this command is
    // invalid. The assertion is only that `prompt` is not among the reasons: a length issue here is
    // the metadata bound reaching the interactive site this provider parses in `sendPrompt`.
    const result = agentInterface.AgentInteractiveSessionPromptCommandSchema.safeParse({
      operationId: "interface-floor-probe",
      ref: {
        provider: "tangle-sandbox",
        environmentId: "sandbox-1",
        sessionId: "session-1",
        executionId: "execution-1",
        requestDigest: `sha256:${"a".repeat(64)}`,
      },
      control: {
        refDigest: `sha256:${"b".repeat(64)}`,
        incarnationId: "incarnation-1",
        claimedAtMs: 1,
      },
      prompt: "x".repeat(METADATA_BOUND + 1),
      requestDigest: `sha256:${"c".repeat(64)}`,
    });
    const promptIssues = result.success
      ? []
      : result.error.issues.filter((issue) => issue.path[0] === "prompt");
    expect(
      promptIssues,
      `the resolved @tangle-network/agent-interface (${resolvedInterfaceVersion()}) refuses an interactive prompt for its size, which is the metadata bound reaching the site this provider parses in sendPrompt (agent-sdk#314).`,
    ).toEqual([]);
  });

  it("exports the contract bounds this package validates its own limits against", () => {
    // producer-consumer-bounds.test.ts imports these by name. On a resolution older than 2.8.0 that
    // file does not fail, it fails to LOAD, which is how the seam it guards stops being checked.
    expect(
      agentInterface.CONTRACT_MAX_STRING_LENGTH,
      `the resolved @tangle-network/agent-interface (${resolvedInterfaceVersion()}) does not export CONTRACT_MAX_STRING_LENGTH, which became public in ${REQUIRED_INTERFACE_FLOOR} (agent-sdk#315).`,
    ).toBe(METADATA_BOUND);
    expect(agentInterface.CONTRACT_MAX_IDENTIFIER_LENGTH).toBeTypeOf("number");
    expect(agentInterface.CONTRACT_MAX_ARRAY_LENGTH).toBeTypeOf("number");
    expect(agentInterface.CONTRACT_MAX_JSON_BYTES).toBeTypeOf("number");
  });

  it("resolves an agent-interface at or above the range this package declares", () => {
    const floor = declaredFloor(selfManifest.dependencies?.["@tangle-network/agent-interface"]);
    const resolved = resolvedInterfaceVersion();
    expect(
      compareVersions(resolved, floor),
      `this package resolves @tangle-network/agent-interface ${resolved}, below its declared floor ${floor}. A consumer holding an older lockfile entry gets exactly this split: its runtime on the new contract, its validator on the old one.`,
    ).toBeGreaterThanOrEqual(0);
    // A caret range also has to stay inside the major it was written against.
    expect(Number(resolved.split(".")[0])).toBe(Number(floor.split(".")[0]));
  });

  it("declares a floor at least as high as the contract change its validation needs", () => {
    // Without this the behaviour cases above can pass for the wrong reason: inside this workspace
    // the resolution is overridden to the workspace copy, so a range lowered back to ^2.4.0 would
    // still resolve something new enough to accept a large prompt, and only a consumer would find
    // out.
    const floor = declaredFloor(selfManifest.dependencies?.["@tangle-network/agent-interface"]);
    expect(
      compareVersions(floor, REQUIRED_INTERFACE_FLOOR),
      `agent-provider-tangle declares ^${floor} for @tangle-network/agent-interface but its validation needs ${REQUIRED_INTERFACE_FLOOR}: the content-bound prompt (2.7.0) and the public contract bounds (2.8.0). Raise the range, or move this floor and say what changed.`,
    ).toBeGreaterThanOrEqual(0);
  });
});

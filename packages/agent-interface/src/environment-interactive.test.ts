import { describe, expect, it } from "vitest";
import type { AgentProfile } from "./agent-profile.js";
import { canonicalAgentProfileDigest } from "./agent-execution-preparation.js";
import {
  AgentInteractiveSessionRefSchema,
  AgentInteractiveSessionStatusSchema,
  agentInteractiveSessionRequestDigest,
  agentInteractiveSessionRefMatchesStart,
  agentInteractiveSessionRunRef,
  agentInteractiveSessionStatusMatchesRef,
  exactAgentInteractiveSessionStart,
} from "./environment-interactive.js";
import type { AgentExactRunControlRef } from "./runtime-control.js";

const runCoordinates = {
  provider: "tangle",
  environmentId: "sandbox-1",
  sessionId: "session-1",
  executionId: "execution-1",
};

const profile: AgentProfile = {
  name: "Braid product engineer",
  harness: "pi",
  model: {
    provider: "tangle-router",
    default: "zai/glm-5.2",
    reasoningEffort: "high",
  },
};

const profileDigest = canonicalAgentProfileDigest(profile);
const startInput = {
  profile,
  requestedProfileDigest: profileDigest,
  initialPrompt: "Inspect this workspace and report the test command.",
  cols: 120,
  rows: 40,
} as const;
const run: AgentExactRunControlRef = agentInteractiveSessionRunRef(
  runCoordinates,
  startInput,
);
const admittedProfileDigest = `sha256:${"a".repeat(64)}` as const;
const incarnationId = "interactive-7d404f31";
const startedAt = "2026-08-15T12:00:00.000Z";

describe("exact interactive agent session contract", () => {
  it("binds start and status to the exact run, profile, and harness", () => {
    const request = exactAgentInteractiveSessionStart({
      run,
      ...startInput,
    });
    const ref = AgentInteractiveSessionRefSchema.parse({
      run,
      requestedProfileDigest: profileDigest,
      admittedProfileDigest,
      incarnationId,
      harness: "pi",
      startedAt,
    });
    const status = AgentInteractiveSessionStatusSchema.parse({
      state: "running",
      ref,
    });

    expect(agentInteractiveSessionRefMatchesStart(request, ref)).toBe(true);
    expect(agentInteractiveSessionStatusMatchesRef(ref, status)).toBe(true);
  });

  it("derives one stable run identity and changes it with start semantics", () => {
    expect(agentInteractiveSessionRequestDigest(runCoordinates, startInput)).toBe(
      run.requestDigest,
    );
    expect(agentInteractiveSessionRunRef(runCoordinates, startInput)).toEqual(run);
    expect(
      agentInteractiveSessionRunRef(runCoordinates, {
        ...startInput,
        initialPrompt: "Run a different task.",
      }).requestDigest,
    ).not.toBe(run.requestDigest);
    expect(
      agentInteractiveSessionRunRef(
        { ...runCoordinates, executionId: "execution-2" },
        startInput,
      ).runId,
    ).not.toBe(run.runId);
  });

  it("rejects a profile without a selected harness and a mismatched digest", () => {
    expect(() =>
      exactAgentInteractiveSessionStart({
        run,
        profile: { ...profile, harness: undefined },
        requestedProfileDigest: canonicalAgentProfileDigest({
          ...profile,
          harness: undefined,
        }),
      }),
    ).toThrow(/AgentProfile\.harness/u);

    expect(() =>
      exactAgentInteractiveSessionStart({
        run,
        profile,
        requestedProfileDigest: `sha256:${"2".repeat(64)}`,
      }),
    ).toThrow(/profile digest/u);
  });

  it("rejects a provider answer for another run or profile", () => {
    const request = exactAgentInteractiveSessionStart({
      run,
      ...startInput,
    });
    const ref = AgentInteractiveSessionRefSchema.parse({
      run,
      requestedProfileDigest: profileDigest,
      admittedProfileDigest,
      incarnationId,
      harness: "pi",
      startedAt,
    });

    expect(
      agentInteractiveSessionRefMatchesStart(request, {
        ...ref,
        run: { ...run, executionId: "execution-other" },
      }),
    ).toBe(false);
    expect(
      agentInteractiveSessionRefMatchesStart(request, {
        ...ref,
        requestedProfileDigest: `sha256:${"3".repeat(64)}`,
      }),
    ).toBe(false);
    expect(
      agentInteractiveSessionStatusMatchesRef(ref, {
        state: "running",
        ref: { ...ref, incarnationId: "interactive-replacement" },
      }),
    ).toBe(false);
    expect(
      agentInteractiveSessionStatusMatchesRef(ref, {
        state: "running",
        ref: {
          ...ref,
          admittedProfileDigest: `sha256:${"4".repeat(64)}`,
        },
      }),
    ).toBe(false);
  });

  it("rejects a caller-authored run identity that does not match the start", () => {
    expect(() =>
      exactAgentInteractiveSessionStart({
        run: {
          ...run,
          runId: "interactive-run-forged",
        },
        ...startInput,
      }),
    ).toThrow(/run identity/u);
    expect(() =>
      exactAgentInteractiveSessionStart({
        run,
        ...startInput,
        initialPrompt: "Changed after the run identity was minted.",
      }),
    ).toThrow(/run identity/u);
  });

  it("keeps process ids, commands, and environment data out of durable refs", () => {
    expect(
      AgentInteractiveSessionRefSchema.safeParse({
        run,
        requestedProfileDigest: profileDigest,
        admittedProfileDigest,
        incarnationId,
        harness: "pi",
        startedAt,
        pid: 42,
      }).success,
    ).toBe(false);
    expect(
      AgentInteractiveSessionRefSchema.safeParse({
        run,
        requestedProfileDigest: profileDigest,
        admittedProfileDigest,
        incarnationId,
        harness: "pi",
        startedAt,
        env: { API_KEY: "secret" },
      }).success,
    ).toBe(false);
  });

  it("accepts an unnamed profile and keeps requested and admitted identities separate", () => {
    const unnamed = { ...profile, name: undefined };
    const requestedProfileDigest = canonicalAgentProfileDigest(unnamed);
    const unnamedInput = { profile: unnamed, requestedProfileDigest };
    const unnamedRun = agentInteractiveSessionRunRef(
      runCoordinates,
      unnamedInput,
    );
    const request = exactAgentInteractiveSessionStart({
      run: unnamedRun,
      ...unnamedInput,
    });
    const ref = AgentInteractiveSessionRefSchema.parse({
      run: unnamedRun,
      requestedProfileDigest,
      admittedProfileDigest,
      incarnationId,
      harness: "pi",
      startedAt,
    });

    expect(agentInteractiveSessionRefMatchesStart(request, ref)).toBe(true);
    expect(ref.admittedProfileDigest).not.toBe(ref.requestedProfileDigest);
  });
});

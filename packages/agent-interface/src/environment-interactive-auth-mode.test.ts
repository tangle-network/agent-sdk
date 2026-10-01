import { describe, expect, it } from "vitest";
import type { AgentProfile } from "./agent-profile.js";
import { canonicalAgentProfileDigest } from "./agent-execution-preparation.js";
import {
  agentInteractiveSessionRunRef,
  exactAgentInteractiveSessionStart,
} from "./environment-interactive-start.js";

describe("interactive-start auth mode", () => {
  it("binds Claude OAuth into the exact run identity", () => {
    const profile: AgentProfile = {
      name: "interactive-auth-mode-test",
      harness: "claude-code",
    };
    const coordinates = {
      provider: "test-provider",
      environmentId: "test-environment",
      sessionId: "session-auth-mode",
      executionId: "execution-auth-mode",
    };
    const ordinaryInput = {
      profile,
      requestedProfileDigest: canonicalAgentProfileDigest(profile),
    };
    const oauthInput = { ...ordinaryInput, authMode: "oauth" as const };
    const ordinaryRun = agentInteractiveSessionRunRef(
      coordinates,
      ordinaryInput,
    );
    const oauthRun = agentInteractiveSessionRunRef(coordinates, oauthInput);

    expect(oauthRun.requestDigest).not.toBe(ordinaryRun.requestDigest);
    const parsed = exactAgentInteractiveSessionStart({
      run: oauthRun,
      ...oauthInput,
    });
    expect(parsed.authMode).toBe("oauth");
    expect(() =>
      exactAgentInteractiveSessionStart({ run: oauthRun, ...ordinaryInput }),
    ).toThrow(/run identity/u);
  });

  it("rejects Claude OAuth for another harness", () => {
    const profile: AgentProfile = {
      name: "interactive-auth-mode-test",
      harness: "codex",
    };
    const input = {
      profile,
      requestedProfileDigest: canonicalAgentProfileDigest(profile),
      authMode: "oauth" as const,
    };
    const run = agentInteractiveSessionRunRef(
      {
        provider: "test-provider",
        environmentId: "test-environment",
        sessionId: "session-auth-mode",
        executionId: "execution-auth-mode",
      },
      input,
    );

    expect(() => exactAgentInteractiveSessionStart({ run, ...input })).toThrow(
      /requires the claude-code harness/u,
    );
  });
});

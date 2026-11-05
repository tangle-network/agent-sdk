import { describe, expect, it } from "vitest";
import * as contract from "./index.js";
import type { AgentIdentity } from "./index.js";

const TRACE = "trace-1";
const START = "2026-07-31T10:00:00.000Z";

describe("who acted: agent identity on every builder", () => {
  // Through the package entry, the surface a producer imports.
  const IDENTITY: AgentIdentity = {
    profileDigest: "sha256:abc",
    profileName: "coder",
    model: "claude-opus-4",
    harness: "claude-code",
    skillsDigest: "sha256:def",
    directiveVariant: "terse",
  };
  const STAMPED = {
    "agent.profile.digest": "sha256:abc",
    "agent.profile.name": "coder",
    "agent.model": "claude-opus-4",
    "agent.harness": "claude-code",
    "agent.skills.digest": "sha256:def",
    "agent.directive.variant": "terse",
  };
  const base = { traceId: TRACE, spanId: "s", name: "n", startTime: START };

  it("stamps the same six keys on every span kind a builder makes", () => {
    const spans = [
      contract.contractSpan({ ...base, kind: "AGENT", agent: IDENTITY }),
      contract.llmSpan({ ...base, model: "claude-haiku-4", agent: IDENTITY }),
      contract.toolSpan({ ...base, toolName: "Bash", agent: IDENTITY }),
      contract.loopSpan({ ...base, loopId: "l", iteration: 1, agent: IDENTITY }),
      contract.branchSpan({ ...base, branchId: "b", agent: IDENTITY }),
    ];
    for (const span of spans) expect(span.attributes).toMatchObject(STAMPED);
    // The agent's model and the call's model are different facts and both survive.
    expect(spans[1]?.attributes[contract.ATTR.model]).toBe("claude-haiku-4");
    expect(spans[1]?.attributes[contract.ATTR.agentModel]).toBe("claude-opus-4");
  });

  it("writes nothing for an absent, empty or non-string field", () => {
    const span = contract.contractSpan({
      ...base,
      agent: {
        profileName: "coder",
        profileDigest: "",
        model: 4 as unknown as string,
        harness: undefined,
      },
    });
    expect(span.attributes).toEqual({ "agent.profile.name": "coder" });
    expect(contract.contractSpan(base).attributes).toEqual({});
  });

  it("lets the typed identity win over a raw attribute of the same key", () => {
    const span = contract.contractSpan({
      ...base,
      attributes: { "agent.profile.name": "stale", "vendor.custom": 1 },
      agent: { profileName: "coder" },
    });
    expect(span.attributes).toEqual({
      "agent.profile.name": "coder",
      "vendor.custom": 1,
    });
  });

  it("reads an identity of any shape without throwing", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("trap");
        },
      },
    );
    for (const value of [undefined, null, 7, "coder", [], hostile]) {
      expect(contract.agentIdentityAttributes(value as unknown as AgentIdentity)).toEqual({});
    }
    expect(contract.agentIdentityAttributes(IDENTITY)).toEqual(STAMPED);
  });
});

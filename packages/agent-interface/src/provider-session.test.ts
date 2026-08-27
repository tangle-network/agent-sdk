import { describe, expect, it } from "vitest";
import { snapshotAgentProviderSessionRef } from "./provider-session.js";

function providerSession() {
  return {
    provider: "cli-bridge",
    backend: "pi",
    externalId: "runtime-node",
    nativeSessionId: "pi-native-session",
    cwd: "/workspace",
    nativePromptCount: 1,
    controllerTurns: [{
      ordinal: 1,
      runId: "runtime-node:turn-1",
      bridgeRequestDigest: `sha256:${"b".repeat(64)}`,
      promptSha256: `sha256:${"a".repeat(64)}`,
      startedAt: 100,
      endedAt: 200,
    }],
  };
}

describe("snapshotAgentProviderSessionRef", () => {
  it("detaches and deeply freezes the complete typed receipt", () => {
    const input = providerSession();
    const snapshot = snapshotAgentProviderSessionRef(input);

    input.backend = "codex";
    input.controllerTurns[0]!.runId = "mutated";

    expect(snapshot.backend).toBe("pi");
    expect(snapshot.controllerTurns[0]?.runId).toBe("runtime-node:turn-1");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.controllerTurns)).toBe(true);
    expect(Object.isFrozen(snapshot.controllerTurns[0])).toBe(true);
    expect(() => {
      (snapshot.controllerTurns as unknown as Array<{ runId: string }>)[0]!.runId = "mutated";
    }).toThrow();
  });

  it.each([
    { field: "lowercase prompt digest", mutate: (value: ReturnType<typeof providerSession>) => {
      value.controllerTurns[0]!.promptSha256 = `sha256:${"A".repeat(64)}`;
    } },
    { field: "provider interval", mutate: (value: ReturnType<typeof providerSession>) => {
      value.controllerTurns[0]!.endedAt = 99;
    } },
    { field: "bridge request digest", mutate: (value: ReturnType<typeof providerSession>) => {
      value.controllerTurns[0]!.bridgeRequestDigest = "not-a-digest";
    } },
    { field: "ordered ordinals", mutate: (value: ReturnType<typeof providerSession>) => {
      value.controllerTurns.push({
        ...value.controllerTurns[0]!,
        ordinal: 1,
        runId: "runtime-node:turn-2",
      });
    } },
    { field: "unique run ids", mutate: (value: ReturnType<typeof providerSession>) => {
      value.controllerTurns.push({
        ...value.controllerTurns[0]!,
        ordinal: 2,
      });
    } },
    { field: "non-overlapping intervals", mutate: (value: ReturnType<typeof providerSession>) => {
      value.nativePromptCount = 2;
      value.controllerTurns.push({
        ...value.controllerTurns[0]!,
        ordinal: 2,
        runId: "runtime-node:turn-2",
        startedAt: 199,
        endedAt: 250,
      });
    } },
    { field: "native prompt count coverage", mutate: (value: ReturnType<typeof providerSession>) => {
      value.nativePromptCount = 0;
    } },
  ])("fails closed on malformed $field", ({ mutate }) => {
    const value = providerSession();
    mutate(value);
    expect(() => snapshotAgentProviderSessionRef(value)).toThrow();
  });

  it("accepts a locating reference when exact prompt bytes are unavailable", () => {
    const value = providerSession();
    value.controllerTurns = [];
    expect(snapshotAgentProviderSessionRef(value).controllerTurns).toEqual([]);
  });
});

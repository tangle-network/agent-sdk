import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentEnvironmentObservationSchema,
  SafeEndpointSchema,
  agentEnvironmentObservationIdentityMatches,
  assertObservationCredentialFree,
  observationContainsCredential,
  observationOf,
  type AgentEnvironmentObservation,
} from "./environment-observation.js";

const provenance = {
  origin: "measured" as const,
  observedAt: "2026-08-12T10:00:00.000Z",
  source: "runtime-probe",
};

function makeObservation(): AgentEnvironmentObservation {
  return {
    subject: {
      provider: "tangle",
      environmentId: "env-1",
      sessionId: "session-1",
      backend: "opencode",
    },
    capturedAt: "2026-08-12T10:00:01.000Z",
    identity: {
      state: "known",
      value: { provider: "tangle", environmentId: "env-1", sessionId: "session-1" },
      provenance,
    },
    lifecycle: {
      state: "known",
      value: {
        status: "running",
        cleanup: { policy: "idle", confirmed: false },
        continuity: { resumable: true, mode: "native" },
        persistence: { durable: true, scope: "durable" },
      },
      provenance,
    },
    endpoint: {
      state: "known",
      value: {
        scheme: "https",
        host: "env-1.sandbox.tangle.tools",
        port: 8080,
        region: "us-east",
      },
      provenance,
    },
    placement: {
      requested: { kind: "sandbox", region: "us-east" },
      verified: {
        state: "known",
        value: { kind: "sandbox", sandboxId: "sb-1", region: "us-east" },
        provenance,
      },
    },
    resources: {
      requested: { cpu: 2, memoryMb: 4096, diskMb: 20_480 },
      effective: {
        state: "known",
        value: {
          cpu: 2,
          memoryMb: 4096,
          diskMb: 20_480,
          accelerator: { kind: "nvidia-l4", count: 1, memoryMb: 24_576 },
        },
        provenance,
      },
    },
    resourceUse: {
      current: { state: "known", value: { cpu: 0.5, memoryMb: 1024 }, provenance },
      peak: { state: "known", value: { cpu: 1.5, memoryMb: 3072 }, provenance },
    },
    modelUsage: {
      state: "known",
      value: { inputTokens: 100, outputTokens: 50, cost: 0.02 },
      provenance,
    },
    computeBilling: {
      state: "known",
      value: { amount: 0.12, currency: "usd" },
      provenance,
    },
    accountUsage: {
      plan: { state: "known", value: "pro", provenance },
      credits: {
        state: "known",
        value: { remaining: 1000, unit: "credit" },
        provenance,
      },
      quota: { state: "unavailable", reason: "provider does not expose quota" },
      period: {
        state: "known",
        value: {
          start: "2026-08-01T00:00:00.000Z",
          end: "2026-09-01T00:00:00.000Z",
        },
        provenance,
      },
    },
  };
}

describe("AgentEnvironmentObservationSchema", () => {
  it("parses a fully populated observation", () => {
    const observation = makeObservation();
    expect(AgentEnvironmentObservationSchema.parse(observation)).toEqual(observation);
  });

  it("validates a provider that declares no observed surfaces", () => {
    const minimal = {
      subject: { provider: "cli-bridge", environmentId: "env-2" },
      capturedAt: "2026-08-12T10:00:01.000Z",
    };
    expect(AgentEnvironmentObservationSchema.parse(minimal)).toEqual(minimal);
  });

  it("requires the subject identity and capture time", () => {
    expect(
      AgentEnvironmentObservationSchema.safeParse({
        capturedAt: "2026-08-12T10:00:01.000Z",
      }).success,
    ).toBe(false);
    expect(
      AgentEnvironmentObservationSchema.safeParse({
        subject: { provider: "tangle", environmentId: "env-1" },
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown observation surface", () => {
    expect(
      AgentEnvironmentObservationSchema.safeParse({
        subject: { provider: "tangle", environmentId: "env-1" },
        capturedAt: "2026-08-12T10:00:01.000Z",
        listenerAddress: "10.0.0.1:22",
      }).success,
    ).toBe(false);
  });
});

describe("observationOf freshness discriminator", () => {
  const numberObservation = observationOf(z.number().finite());

  it("requires the state discriminator on every payload", () => {
    expect(numberObservation.safeParse({ value: 5, provenance }).success).toBe(false);
  });

  it("carries a value only on known and stale", () => {
    expect(numberObservation.parse({ state: "known", value: 5, provenance }).state).toBe(
      "known",
    );
    expect(
      numberObservation.parse({ state: "stale", value: 5, provenance, reason: "cache" })
        .state,
    ).toBe("stale");
    for (const state of ["unavailable", "redacted"] as const) {
      expect(numberObservation.parse({ state, reason: "no probe" }).state).toBe(state);
    }
    expect(numberObservation.parse({ state: "unknown" }).state).toBe("unknown");
  });

  it("never lets a missing value read as a measured zero", () => {
    expect(
      numberObservation.safeParse({ state: "unavailable", reason: "no probe", value: 0 })
        .success,
    ).toBe(false);
    expect(numberObservation.safeParse({ state: "unknown", value: 0 }).success).toBe(false);
    expect(
      numberObservation.safeParse({ state: "redacted", reason: "confidential", value: 0 })
        .success,
    ).toBe(false);
  });

  it("requires a reason on unavailable, stale, and redacted", () => {
    expect(numberObservation.safeParse({ state: "unavailable" }).success).toBe(false);
    expect(numberObservation.safeParse({ state: "redacted" }).success).toBe(false);
    expect(
      numberObservation.safeParse({ state: "stale", value: 5, provenance }).success,
    ).toBe(false);
  });
});

describe("SafeEndpointSchema", () => {
  it("accepts a credential-free endpoint", () => {
    expect(
      SafeEndpointSchema.parse({ scheme: "https", host: "example.com", port: 443 }).host,
    ).toBe("example.com");
  });

  it("rejects embedded userinfo and a scheme carrying credentials", () => {
    expect(SafeEndpointSchema.safeParse({ host: "user:pass@example.com" }).success).toBe(
      false,
    );
    expect(SafeEndpointSchema.safeParse({ host: "example.com/path" }).success).toBe(false);
    expect(
      SafeEndpointSchema.safeParse({ host: "example.com", scheme: "https://user@" })
        .success,
    ).toBe(false);
  });

  it("has no structural field for a credential", () => {
    expect(
      SafeEndpointSchema.safeParse({ host: "example.com", token: "secret" }).success,
    ).toBe(false);
  });
});

describe("observationContainsCredential", () => {
  it("flags secret-shaped keys and userinfo URLs", () => {
    expect(observationContainsCredential({ authorization: "Bearer x" })).toBe(true);
    expect(observationContainsCredential({ password: "x" })).toBe(true);
    expect(observationContainsCredential({ nested: { apiKey: "x" } })).toBe(true);
    expect(observationContainsCredential({ accessToken: "x" })).toBe(true);
    expect(observationContainsCredential({ url: "https://user:pass@host/x" })).toBe(true);
  });

  it("does not flag token-count fields or the observation surface", () => {
    expect(observationContainsCredential({ inputTokens: 10, outputTokens: 5 })).toBe(false);
    expect(observationContainsCredential({ sessionId: "s", kind: "sandbox" })).toBe(false);
    expect(observationContainsCredential(makeObservation())).toBe(false);
    expect(() => assertObservationCredentialFree(makeObservation())).not.toThrow();
    expect(() => assertObservationCredentialFree({ secret: "x" })).toThrow();
  });
});

describe("agentEnvironmentObservationIdentityMatches", () => {
  it("holds when a live observation and its replay share identity and provenance", () => {
    const live = makeObservation();
    const replay: AgentEnvironmentObservation = {
      ...makeObservation(),
      capturedAt: "2026-08-12T11:30:00.000Z",
      lifecycle: { state: "stale", value: { status: "running" }, provenance, reason: "cache" },
    };
    expect(agentEnvironmentObservationIdentityMatches(live, replay)).toBe(true);
  });

  it("fails when the subject identity differs", () => {
    const live = makeObservation();
    const replay: AgentEnvironmentObservation = {
      ...makeObservation(),
      subject: { provider: "tangle", environmentId: "env-9" },
    };
    expect(agentEnvironmentObservationIdentityMatches(live, replay)).toBe(false);
  });

  it("fails when the observed identity or its provenance source differs", () => {
    const live = makeObservation();
    const identityDrift: AgentEnvironmentObservation = {
      ...makeObservation(),
      identity: {
        state: "known",
        value: { provider: "tangle", environmentId: "env-1", sessionId: "session-2" },
        provenance,
      },
    };
    expect(agentEnvironmentObservationIdentityMatches(live, identityDrift)).toBe(false);
    const sourceDrift: AgentEnvironmentObservation = {
      ...makeObservation(),
      identity: {
        state: "known",
        value: { provider: "tangle", environmentId: "env-1", sessionId: "session-1" },
        provenance: { ...provenance, source: "other-probe" },
      },
    };
    expect(agentEnvironmentObservationIdentityMatches(live, sourceDrift)).toBe(false);
  });
});

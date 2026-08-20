import { describe, expect, it, vi } from "vitest";
import type {
  BackendRegistryResponse,
  SandboxEvent,
  SandboxRuntimeCapabilities,
} from "@tangle-network/sandbox";
import { runAgentEnvironmentProviderConformance } from "@tangle-network/agent-provider-testkit";
import { agentRunCancellationRequestDigest } from "@tangle-network/agent-interface";
import type { AgentExactRunControlRef } from "@tangle-network/agent-interface";
import type { AgentEnvironmentCapabilities } from "@tangle-network/agent-interface/environment-provider";
import {
  createTangleProvider,
  type SandboxClientLike,
  type SandboxInstanceLike,
  type SandboxRuntimeCapabilityDocument,
} from "./index.js";
import {
  deploymentCapabilitySupport,
  readDeploymentCapabilitySupport,
  UNPROVEN_DEPLOYMENT,
} from "./tangle-deployment-capabilities.js";
import {
  RETAINED_DEPLOYMENT_DOCUMENT,
  retainedSessionHandle,
} from "./retained-control-test-helpers.js";

/**
 * The published SDK document is the wire fact this adapter reads. Assigning
 * it to the adapter's own shape holds the two together: a field the SDK
 * renames or retypes fails here instead of silently reading as unknown.
 */
const PUBLISHED_DOCUMENT: SandboxRuntimeCapabilities = {
  schema: 1,
  agentInterface: "0.49.0",
  sidecarVersion: "1.2.3",
  image: `example/sidecar@sha256:${"b".repeat(64)}`,
  dispatch: { runControlRef: true, executionIdOnAdmission: true },
  cancel: { canonicalRunCancellation: true, digestBound: true, idempotent: true },
  runs: { executionScopedStatus: true, eventReplay: true },
  interactions: {},
};
const PUBLISHED_DOCUMENT_AS_READ: SandboxRuntimeCapabilityDocument =
  PUBLISHED_DOCUMENT;

const OPENCODE_BACKEND_CATALOG: BackendRegistryResponse = {
  backends: [
    {
      type: "opencode",
      name: "OpenCode",
      description: "test backend",
      capabilities: {
        streaming: true,
        toolUse: true,
        reasoning: true,
        multimodal: false,
        imageInput: false,
        contextWindow: 128_000,
        mcp: true,
        sessions: true,
        configurable: true,
        interactions: ["permission", "question", "plan"],
      },
    },
  ],
  timestamp: new Date(0).toISOString(),
};

/**
 * One capable sandbox behind one deployment. Every local method retained
 * control needs is present, so the capability document is the only variable:
 * whatever the environment ends up offering, the deployment decided it.
 */
function deployedProvider(options: {
  capabilities?: () => Promise<SandboxRuntimeCapabilityDocument | null>;
  status?: unknown;
}) {
  const sessionId = "session-deployment";
  const deleted = vi.fn(async () => undefined);
  const box: SandboxInstanceLike = {
    id: "sbx-deployment",
    status: options.status ?? "running",
    async *streamPrompt() {},
    dispatchPrompt: async (_message, promptOptions) => ({
      sessionId: promptOptions?.sessionId ?? sessionId,
      executionId: promptOptions?.executionId,
      runControlRef: promptOptions?.runControlRef,
      status: "running",
      alreadyExisted: false,
      dispatched: true,
    }),
    session: retainedSessionHandle,
    delete: deleted,
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
  };
  const provider = createTangleProvider({
    client: {
      create: async () => box,
      get: async (id) => (id === box.id ? box : null),
    },
  });
  return { provider, box, sessionId, deleted };
}

/**
 * One SDK-backed client, so the client stage mints the linked SDK probe and
 * measures its complete method surface. The sandbox carries every workspace,
 * session, observation, and terminal source that surface promises, which
 * leaves the deployment document as the single variable between the two
 * capability stages.
 */
function sdkBackedProvider(document: SandboxRuntimeCapabilityDocument | null) {
  const files = new Map<string, string>();
  const sessionId = "session-sdk-backed";
  const box: SandboxInstanceLike = {
    id: "sbx-sdk-backed",
    status: "running",
    connection: { runtimeUrl: "https://sbx-sdk-backed.runtime.example:8443/v1" },
    gpuLease: {
      accelerator: { kind: "nvidia-h100", count: 1 },
      estimatedCustomerCostUsd: 2.5,
    },
    resourceUsage: async () => ({
      memoryCurrentMb: 512,
      memoryPeakMb: 900,
      memoryLimitMb: 4_096,
      cpuUsageUsec: 1_000,
      sampledAtMs: Date.parse("2026-08-13T00:00:00.000Z"),
    }),
    terminals: {
      get: async () => null,
      attach: async () => {
        throw new Error("the capability stage must not open a terminal socket");
      },
    },
    async *streamPrompt(_message, promptOptions): AsyncIterable<SandboxEvent> {
      yield {
        type: "result",
        data: {
          finalText: "ok",
          sessionId: promptOptions?.sessionId ?? sessionId,
          ...(promptOptions?.executionId
            ? { executionId: promptOptions.executionId }
            : {}),
        },
      } as SandboxEvent;
    },
    dispatchPrompt: async (_message, promptOptions) => ({
      sessionId: promptOptions?.sessionId ?? sessionId,
      executionId: promptOptions?.executionId,
      runControlRef: promptOptions?.runControlRef,
      status: "running",
      alreadyExisted: false,
      dispatched: true,
    }),
    session: retainedSessionHandle,
    read: async (path) => files.get(path) ?? "",
    write: async (path, content) => {
      files.set(path, content);
      return { path, written: true };
    },
    exec: async () => ({ exitCode: 0, stdout: "ok\n", stderr: "" }),
    capabilities: async () => document,
    delete: async () => undefined,
  };
  const client: SandboxClientLike = {
    create: async () => box,
    get: async (id) => (id === box.id ? box : null),
    // The SDK transport the client stage mints its probe over. The probe is
    // lazy, so a request here means it stopped being lazy.
    fetch: async () => {
      throw new Error("the capability probe must not send a request");
    },
    listBackends: async () => OPENCODE_BACKEND_CATALOG,
  };
  return {
    provider: createTangleProvider({ client, defaultBackend: "opencode" }),
    box,
    sessionId,
  };
}

/**
 * Every claim a capability document carries, addressed by path. A relation
 * between two documents is stated over all of them rather than over a chosen
 * few, so a claim the schema gains later joins the comparison on its own.
 */
function capabilityClaims(
  document: AgentEnvironmentCapabilities,
): Map<string, boolean> {
  const claims = new Map<string, boolean>();
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "boolean") {
      claims.set(path, value);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      walk(nested, path === "" ? key : `${path}.${key}`);
    }
  };
  walk(document, "");
  return claims;
}

/** The claims the connected deployment decides, and only those. */
const DEPLOYMENT_DECIDED_CLAIMS = [
  "streaming.detach",
  "streaming.replay",
  "streaming.turnIdempotency",
  "sessions.continue",
  "retainedControl",
  "interactions",
  "interactiveAgent",
] as const;

function decidedByDeployment(path: string): boolean {
  return DEPLOYMENT_DECIDED_CLAIMS.some(
    (claim) => path === claim || path.startsWith(`${claim}.`),
  );
}

function deploymentDecidedClaims(document: AgentEnvironmentCapabilities) {
  return {
    detach: document.streaming.detach,
    replay: document.streaming.replay,
    turnIdempotency: document.streaming.turnIdempotency,
    continued: document.sessions.continue,
    retainedControl: document.retainedControl !== undefined,
    interactions: document.interactions !== undefined,
    interactiveAgent:
      document.interactiveAgent !== undefined &&
      Object.values(document.interactiveAgent).some(Boolean),
  };
}

function claimsTheDeploymentDoesNotDecide(
  document: AgentEnvironmentCapabilities,
): Record<string, boolean> {
  return Object.fromEntries(
    [...capabilityClaims(document)].filter(([path]) => !decidedByDeployment(path)),
  );
}

/** The paths where one document claims what the other does not back. */
function claimsBeyond(
  document: AgentEnvironmentCapabilities,
  ceiling: AgentEnvironmentCapabilities,
): string[] {
  const bound = capabilityClaims(ceiling);
  return [...capabilityClaims(document)]
    .filter(([path, claimed]) => claimed && bound.get(path) !== true)
    .map(([path]) => path);
}

describe("Tangle deployment capability discovery", () => {
  it("claims retained control when the deployment reports the complete flag set", async () => {
    const capabilities = vi.fn(async () => PUBLISHED_DOCUMENT_AS_READ);
    const { provider, sessionId } = deployedProvider({ capabilities });
    const environment = await provider.create({ profile: { name: "worker" } });

    expect(capabilities).toHaveBeenCalledTimes(1);
    expect(typeof environment.dispatch).toBe("function");
    const reference = await environment.dispatch!({
      prompt: "retained by the deployment",
      sessionId,
      turnId: "deployment-turn",
    });
    const session = environment.session!(sessionId, {
      controlRef: reference.controlRef,
    });
    expect(typeof session.cancelRun).toBe("function");

    const run = reference.controlRef as AgentExactRunControlRef;
    const material = { operationId: "deployment-cancel", run };
    await expect(
      session.cancelRun!({
        ...material,
        requestDigest: agentRunCancellationRequestDigest(material),
      }),
    ).resolves.toMatchObject({ status: "accepted", run });
  });

  it("claims nothing when the deployment cannot disclose a document", async () => {
    // A deployment predating capability discovery, or one serving a schema
    // this SDK cannot read, arrives as null. Unknown is not a claim, and the
    // session surface goes with it: result identity, cursor replay, and
    // canonical cancellation all rest on facts this deployment never reported.
    const { provider } = deployedProvider({ capabilities: async () => null });
    const environment = await provider.create({ profile: { name: "worker" } });

    expect(environment.dispatch).toBeUndefined();
    expect(environment.session).toBeUndefined();
    expect(environment.capabilities).toMatchObject({
      streaming: { detach: false, replay: false, turnIdempotency: false },
      sessions: { continue: false },
    });
    expect(environment.capabilities).not.toHaveProperty("retainedControl");
  });

  it("claims nothing when the linked SDK predates capability discovery", async () => {
    // No `capabilities` method at all: the adapter cannot read deployment
    // truth, so it must not fall back to its own method surface.
    const { provider } = deployedProvider({});
    const environment = await provider.create({ profile: { name: "worker" } });

    expect(environment.dispatch).toBeUndefined();
    expect(environment.session).toBeUndefined();
  });

  it("claims nothing when the sandbox is not running to answer", async () => {
    const capabilities = vi.fn(async () => PUBLISHED_DOCUMENT_AS_READ);
    const { provider } = deployedProvider({
      capabilities,
      status: "stopped",
    });
    const environment = await provider.get!("sbx-deployment");

    expect(capabilities).not.toHaveBeenCalled();
    expect(environment!.dispatch).toBeUndefined();
    expect(environment!.session).toBeUndefined();
  });

  it("drops every claim its single missing flag backs", async () => {
    // One flag at a time, dropped from a complete document. Each row states
    // what survives without that flag, so a claim that outlives the flag it
    // rests on fails here instead of reaching a caller.
    const cases = [
      {
        flag: "dispatch.runControlRef",
        document: {
          ...RETAINED_DEPLOYMENT_DOCUMENT,
          dispatch: { executionIdOnAdmission: true },
        },
        detach: false,
        replay: true,
      },
      {
        flag: "dispatch.executionIdOnAdmission",
        document: {
          ...RETAINED_DEPLOYMENT_DOCUMENT,
          dispatch: { runControlRef: true },
        },
        detach: false,
        replay: true,
      },
      {
        flag: "cancel.canonicalRunCancellation",
        document: {
          ...RETAINED_DEPLOYMENT_DOCUMENT,
          cancel: { digestBound: true, idempotent: true },
        },
        detach: true,
        replay: true,
      },
      {
        flag: "cancel.digestBound",
        document: {
          ...RETAINED_DEPLOYMENT_DOCUMENT,
          cancel: { canonicalRunCancellation: true, idempotent: true },
        },
        detach: true,
        replay: true,
      },
      {
        flag: "cancel.idempotent",
        document: {
          ...RETAINED_DEPLOYMENT_DOCUMENT,
          cancel: { canonicalRunCancellation: true, digestBound: true },
        },
        detach: true,
        replay: true,
      },
      {
        flag: "runs.eventReplay",
        document: {
          ...RETAINED_DEPLOYMENT_DOCUMENT,
          runs: { executionScopedStatus: true },
        },
        detach: true,
        replay: false,
      },
      {
        flag: "runs.executionScopedStatus",
        document: {
          ...RETAINED_DEPLOYMENT_DOCUMENT,
          runs: { eventReplay: true },
        },
        detach: true,
        replay: true,
      },
    ] as const;

    for (const testCase of cases) {
      const { provider, sessionId } = deployedProvider({
        capabilities: async () => testCase.document,
      });
      const environment = await provider.create({ profile: { name: "worker" } });
      const claimed = environment.capabilities!;

      expect({
        flag: testCase.flag,
        detach: claimed.streaming.detach,
        replay: claimed.streaming.replay,
        continued: claimed.sessions.continue,
      }).toEqual({
        flag: testCase.flag,
        detach: testCase.detach,
        replay: testCase.replay,
        continued: false,
      });
      expect(claimed).not.toHaveProperty("retainedControl");
      // A partial document keeps every operation its remaining flags back, so
      // the exposed operations follow the claims that survived the missing one.
      expect(typeof environment.dispatch === "function").toBe(
        claimed.streaming.detach,
      );
      expect(typeof environment.session === "function").toBe(
        claimed.streaming.detach ||
          claimed.streaming.replay ||
          claimed.sessions.continue,
      );
      expect(environment.session!(sessionId).cancelRun).toBeUndefined();
    }
  });

  it("claims nothing and keeps the sandbox when capability discovery fails", async () => {
    // Discovery runs against a sandbox a cold provision has already paid for.
    // A failed read is not evidence about the deployment, so the adapter
    // claims nothing, reports the failure, and keeps the sandbox.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { provider, deleted } = deployedProvider({
        capabilities: async () => {
          throw new Error("Capability discovery returned a non-object document");
        },
      });

      const environment = await provider.create({ profile: { name: "worker" } });

      expect(deleted).not.toHaveBeenCalled();
      expect(environment.dispatch).toBeUndefined();
      expect(environment.session).toBeUndefined();
      expect(warned).toHaveBeenCalledWith(
        expect.stringContaining("Tangle capability discovery failed"),
        expect.any(Error),
      );
    } finally {
      warned.mockRestore();
    }
  });

  it("propagates the caller's own abort instead of claiming nothing", async () => {
    const controller = new AbortController();
    const { provider, deleted } = deployedProvider({
      capabilities: () => {
        controller.abort(new Error("caller cancelled"));
        // A read still in flight when the caller aborts: the abort decides.
        return new Promise(() => undefined);
      },
    });

    await expect(
      provider.create({ profile: { name: "worker" }, signal: controller.signal }),
    ).rejects.toThrow(/caller cancelled/);
    expect(deleted).toHaveBeenCalledTimes(1);
  });

  it("propagates the caller's abort when the aborted read fails", async () => {
    // The read fails and the caller's own abort is what failed it. A failed
    // read claims nothing, but only about a deployment that was asked: this
    // read reported on the caller, so the abort leaves the boundary instead
    // of resolving into a fact and instead of reaching the warning channel.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const controller = new AbortController();
      const box: SandboxInstanceLike = {
        id: "sbx-aborted-read",
        status: "running",
        async *streamPrompt() {},
        capabilities: () =>
          new Promise((_resolve, reject) => {
            // Both outcomes are live on the same read: the abort lands while
            // the request is in flight, and the request then fails.
            queueMicrotask(() => {
              controller.abort(new Error("caller cancelled the read"));
              reject(new Error("capability transport closed"));
            });
          }),
      };

      await expect(
        readDeploymentCapabilitySupport(box, { signal: controller.signal }),
      ).rejects.toThrow(/caller cancelled the read/);
      expect(warned).not.toHaveBeenCalled();
    } finally {
      warned.mockRestore();
    }
  });

  it("pairs the client-stage document against the sandbox surface it produces", async () => {
    // The two documents answer different questions, so the relation between
    // them is a bound, not an equality: the client stage states this adapter's
    // ceiling against a deployment that backs everything, and the sandbox
    // stage states what one deployment reported. Three facts hold together.
    // The sandbox stage never claims what the ceiling does not carry, or a
    // caller who selected this provider on the ceiling would meet an operation
    // the provider document never offered. The two stages agree on every claim
    // the deployment does not decide, so a difference between them names a
    // deployment fact and nothing else. The exposed operations follow the
    // sandbox-stage document exactly, which is what the conformance suite
    // checks against the document an environment publishes.
    //
    // Equality across both stages is the wrong assertion. The client stage
    // runs before any sandbox exists, so a deployment that discloses nothing
    // would drag the provider document down and refuse retained runs against
    // every deployment, including the ones that back them.
    for (const testCase of [
      {
        deployment: "undisclosed",
        document: null,
        backed: false,
        interactions: false,
      },
      {
        // Retained control and interaction responses rest on separate flags.
        // This document backs the run operations and stays silent about the
        // response record, so the environment offers retained control and
        // refuses to claim interactions.
        deployment: "retained",
        document: RETAINED_DEPLOYMENT_DOCUMENT,
        backed: true,
        interactions: false,
      },
      {
        deployment: "retained-and-interactive",
        document: {
          ...RETAINED_DEPLOYMENT_DOCUMENT,
          interactions: { responseDedupe: true },
        },
        backed: true,
        interactions: true,
      },
    ] as const) {
      const { provider } = sdkBackedProvider(testCase.document);
      const report = await runAgentEnvironmentProviderConformance({
        name: `tangle-${testCase.deployment}-deployment`,
        createProvider: () => provider,
      });
      const clientStage = report.capabilities;
      const sandboxStage = report.environmentCapabilities;

      expect(report.provider).toBe("tangle-sandbox");
      expect(deploymentDecidedClaims(clientStage)).toEqual({
        detach: true,
        replay: true,
        turnIdempotency: true,
        continued: true,
        retainedControl: true,
        interactions: true,
        interactiveAgent: false,
      });
      expect({
        deployment: testCase.deployment,
        ...deploymentDecidedClaims(sandboxStage),
      }).toEqual({
        deployment: testCase.deployment,
        detach: testCase.backed,
        replay: testCase.backed,
        turnIdempotency: testCase.backed,
        continued: testCase.backed,
        retainedControl: testCase.backed,
        interactions: testCase.interactions,
        interactiveAgent: false,
      });
      expect(claimsBeyond(sandboxStage, clientStage)).toEqual([]);
      expect(claimsTheDeploymentDoesNotDecide(sandboxStage)).toEqual(
        claimsTheDeploymentDoesNotDecide(clientStage),
      );

      const environment = await provider.create({ profile: { name: "worker" } });
      expect(environment.capabilities).toEqual(sandboxStage);
      expect(typeof environment.dispatch === "function").toBe(
        sandboxStage.streaming.detach,
      );
      expect(typeof environment.session === "function").toBe(
        sandboxStage.streaming.detach ||
          sandboxStage.streaming.replay ||
          sandboxStage.sessions.continue,
      );
    }
  });

  it("keeps the published environment document beyond a caller's reach", async () => {
    // The document and the exposed operations are decided together. A caller
    // that could write a flag would describe a surface this environment has
    // no method for, which is the disagreement the document exists to close.
    const { provider } = sdkBackedProvider(null);
    const environment = await provider.create({ profile: { name: "worker" } });
    const published = environment.capabilities as {
      streaming: { detach: boolean };
    };

    expect(() => {
      published.streaming.detach = true;
    }).toThrow(TypeError);
    expect(environment.capabilities!.streaming.detach).toBe(false);
    expect(environment.dispatch).toBeUndefined();
  });

  it("reads every flag as unknown until the document sets it", () => {
    expect(deploymentCapabilitySupport(PUBLISHED_DOCUMENT_AS_READ)).toEqual({
      exactDispatch: true,
      canonicalCancellation: true,
      eventReplay: true,
      executionScopedStatus: true,
      // The published fixture carries an empty `interactions` block, so the
      // flag is unset and the fact stays false.
      interactionResponses: false,
      interactiveAgent: false,
    });
    expect(deploymentCapabilitySupport(null)).toEqual(UNPROVEN_DEPLOYMENT);
    expect(deploymentCapabilitySupport({ schema: 1 })).toEqual(
      UNPROVEN_DEPLOYMENT,
    );
  });
});

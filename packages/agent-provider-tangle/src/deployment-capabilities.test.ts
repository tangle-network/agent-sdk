import { describe, expect, it, vi } from "vitest";
import type { SandboxRuntimeCapabilities } from "@tangle-network/sandbox";
import { agentRunCancellationRequestDigest } from "@tangle-network/agent-interface";
import type { AgentExactRunControlRef } from "@tangle-network/agent-interface";
import type { PromptOptions } from "@tangle-network/sandbox";
import {
  createTangleProvider,
  type SandboxInstanceLike,
  type SandboxRuntimeCapabilityDocument,
  type SandboxSessionLike,
} from "./index.js";
import { deploymentCapabilitySupport } from "./tangle-deployment-capabilities.js";
import { RETAINED_DEPLOYMENT_DOCUMENT } from "./retained-control-test-helpers.js";

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

function echoedExecution(options: PromptOptions | undefined) {
  return options?.executionId;
}

function capableSession(id: string): SandboxSessionLike {
  return {
    id,
    status: async () => ({ status: "running" }),
    async *events() {},
    result: async (options) => ({
      success: true,
      status: "success",
      executionId: echoedExecution(options),
      durationMs: 1,
    }),
    prompt: async (_message, options) => ({
      success: true,
      status: "success",
      executionId: echoedExecution(options),
      durationMs: 1,
    }),
    interrupt: async () => ({ cancelled: true }),
    cancelRun: async (request) => ({
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      run: request.run,
      status: "accepted",
      effect: "not_live",
    }),
  };
}

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
    session: (id) => capableSession(id),
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
    // this SDK cannot read, arrives as null. Unknown is not a claim.
    const { provider, sessionId } = deployedProvider({
      capabilities: async () => null,
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    expect(environment.dispatch).toBeUndefined();
    expect(environment.session!(sessionId).cancelRun).toBeUndefined();
  });

  it("claims nothing when the linked SDK predates capability discovery", async () => {
    // No `capabilities` method at all: the adapter cannot read deployment
    // truth, so it must not fall back to its own method surface.
    const { provider, sessionId } = deployedProvider({});
    const environment = await provider.create({ profile: { name: "worker" } });

    expect(environment.dispatch).toBeUndefined();
    expect(environment.session!(sessionId).cancelRun).toBeUndefined();
  });

  it("claims nothing when the sandbox is not running to answer", async () => {
    const capabilities = vi.fn(async () => PUBLISHED_DOCUMENT_AS_READ);
    const { provider, sessionId } = deployedProvider({
      capabilities,
      status: "stopped",
    });
    const environment = await provider.get!("sbx-deployment");

    expect(capabilities).not.toHaveBeenCalled();
    expect(environment!.dispatch).toBeUndefined();
    expect(environment!.session!(sessionId).cancelRun).toBeUndefined();
  });

  it("drops cancellation but keeps dispatch when only the cancel flags are unreported", async () => {
    // Absence is unknown, so a document that never mentions idempotent
    // cancellation cannot carry retained control. Exact dispatch is a
    // separate flag and survives on its own evidence.
    const { provider, sessionId } = deployedProvider({
      capabilities: async () => ({
        ...RETAINED_DEPLOYMENT_DOCUMENT,
        cancel: { canonicalRunCancellation: true, digestBound: true },
      }),
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    expect(typeof environment.dispatch).toBe("function");
    expect(environment.session!(sessionId).cancelRun).toBeUndefined();
  });

  it("drops dispatch when the deployment does not accept an exact run reference", async () => {
    const { provider, sessionId } = deployedProvider({
      capabilities: async () => ({
        ...RETAINED_DEPLOYMENT_DOCUMENT,
        dispatch: { executionIdOnAdmission: true },
      }),
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    expect(environment.dispatch).toBeUndefined();
    expect(environment.session!(sessionId).cancelRun).toBeUndefined();
  });

  it("fails loud and deletes the sandbox when capability discovery breaks", async () => {
    const { provider, deleted } = deployedProvider({
      capabilities: async () => {
        throw new Error("Capability discovery returned a non-object document");
      },
    });

    await expect(
      provider.create({ profile: { name: "worker" } }),
    ).rejects.toThrow(/Capability discovery returned/);
    expect(deleted).toHaveBeenCalledTimes(1);
  });

  it("reads every flag as unknown until the document sets it", () => {
    expect(deploymentCapabilitySupport(PUBLISHED_DOCUMENT_AS_READ)).toEqual({
      measured: true,
      exactRunControlRef: true,
      canonicalCancellation: true,
    });
    expect(deploymentCapabilitySupport(null)).toEqual({
      measured: true,
      exactRunControlRef: false,
      canonicalCancellation: false,
    });
    expect(deploymentCapabilitySupport({ schema: 1 })).toEqual({
      measured: true,
      exactRunControlRef: false,
      canonicalCancellation: false,
    });
  });
});

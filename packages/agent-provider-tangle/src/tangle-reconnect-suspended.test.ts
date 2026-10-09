/**
 * Reconnect to a retained native execution whose sandbox the platform suspended.
 *
 * Measured 2026-10-04 (Runtime 0.297.5, provider 3.5.1): a root turn stalled on an upstream
 * HTTP 429 for the platform's 30-minute idle window, the sandbox suspended ("project_suspending"),
 * and every later reconnect refused with "Tangle native capture requires the current selected
 * backend before reconnect" until the driver spent all 14 attempts. Nothing resumed the box, so
 * no reconnect could read its backend. These tests pin the repaired sequence: the reconnect
 * resumes the box once, reads the selected backend from the new container, and reports the
 * interrupted execution as a terminal failure without dispatching it again.
 */
import { describe, expect, it } from "vitest";
import { reconnectRetainedRun, startRetainedRun } from "@tangle-network/agent-runtime/kernel";
import type { CreateSandboxOptions } from "@tangle-network/sandbox";
import { createTangleProvider, type SandboxInstanceLike } from "./index.js";
import { RETAINED_DEPLOYMENT_DOCUMENT, retainedDeployment, retainedSessionHandle } from "./retained-control-test-helpers.js";
import type { SandboxSessionLike } from "./tangle-types.js";

const proof = (container: string) => ({
  hostId: "host-1",
  containerId: container.repeat(64),
  imageId: `sha256:${"b".repeat(64)}`,
  bundleRevision: "c".repeat(40),
  bundleChecksum: `sha256:${"d".repeat(64)}`,
});
const profile = { name: "root", harness: "claude-code" as const, model: { default: "fixture-model" } };

function http(status: number, message: string): Error {
  return Object.assign(new Error(`HTTP ${status}: ${message}`), { name: "ServerError", status });
}

function suspendableSandbox() {
  const counts = { dispatches: 0, resumes: 0 };
  let box!: SandboxInstanceLike;
  let container = "a";
  let interrupted = false;
  const session = (id: string): SandboxSessionLike => ({
    ...retainedSessionHandle(id),
    status: async () => {
      if (box.status !== "running") throw http(503, `Sidecar with id ${box.id} is not ready: project_suspended`);
      // The sidecar's durable event buffer settles an execution a container restart cut off.
      return interrupted
        ? { status: "failed", failureReason: { executionId: executionIds[0], message: "Execution interrupted: the agent runtime restarted" } }
        : { status: "running", activeExecutionId: executionIds[0] };
    },
  });
  const executionIds: string[] = [];
  const client = {
    async fetch(): Promise<Response> { throw new Error("capability probe must not call the network"); },
    async create(options: CreateSandboxOptions = {}) {
      box = retainedDeployment({
        id: "sbx-root",
        status: "running",
        metadata: options.metadata,
        captureProof: () => proof(container),
        createReceipt: () => ({ outcome: "created", idempotencyKeyApplied: true, captureProof: proof("a") }),
        backend: {
          status: async () => {
            if (box.status !== "running") throw http(503, "project_suspending");
            return { type: options.backend?.type ?? "unset" };
          },
        },
        async *streamPrompt() {},
        async dispatchPrompt(_message, prompt) {
          counts.dispatches++;
          executionIds.push(prompt?.executionId ?? "");
          return {
            sessionId: prompt?.sessionId, executionId: prompt?.executionId,
            runControlRef: prompt?.runControlRef, status: "running", dispatched: true, alreadyExisted: false,
          };
        },
        session,
        async resume() {
          counts.resumes++;
          // A resume boots a new container incarnation over the preserved workspace.
          container = "e";
          interrupted = true;
          box.status = "running";
        },
        async waitFor() {},
        async refresh() {},
      }, {
        ...RETAINED_DEPLOYMENT_DOCUMENT,
        nativeSessionCaptureVersion: 2,
        nativeSessionCaptureHarnesses: ["claude-code"],
      });
      return box;
    },
    async get(id: string) { return box?.id === id ? box : null; },
  };
  return { client, counts, suspend: () => { box.status = "stopped"; } };
}

describe("Tangle reconnect after the platform suspended a retained sandbox", () => {
  it("resumes once, reads the selected backend, and settles the interrupted execution without a second dispatch", async () => {
    const fixture = suspendableSandbox();
    const provider = createTangleProvider({ client: fixture.client, requireNativeSessionCapture: true });
    const started = await startRetainedRun({
      provider,
      environment: { profile, idempotencyKey: "runtime:root" },
      turn: { prompt: "research", turnId: "root:turn:0" },
      onAdmission: async () => {},
    });
    expect(fixture.counts.dispatches).toBe(1);

    // The turn stalls on an upstream 429 past the idle window; the platform suspends the box.
    fixture.suspend();

    const reconnected = await reconnectRetainedRun({ provider, controlRef: started.controlRef });
    expect(reconnected).not.toBeNull();
    expect(fixture.counts.resumes).toBe(1);
    const snapshot = await reconnected!.status();
    expect(snapshot.status).toBe("failed");
    expect(fixture.counts.dispatches).toBe(1);

    // A second reconnect finds the box running and resumes nothing.
    await reconnectRetainedRun({ provider, controlRef: started.controlRef });
    expect(fixture.counts.resumes).toBe(1);
    expect(fixture.counts.dispatches).toBe(1);
  });

  it("keeps the backend read's own failure as the cause while the box is still suspending", async () => {
    const fixture = suspendableSandbox();
    const provider = createTangleProvider({ client: fixture.client, requireNativeSessionCapture: true });
    const environment = await provider.create({ profile });
    const box = (await fixture.client.get(environment.id))!;
    // Still reported running, but the sidecar already refuses: the transitional window.
    box.backend = { status: async () => { throw http(503, "project_suspending"); } };
    const failure = await provider.get!(environment.id).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/requires the current selected backend before reconnect/);
    expect((failure as Error).cause).toMatchObject({ name: "ServerError", status: 503 });
    expect(fixture.counts.resumes).toBe(0);
  });

  it("waits for a running sandbox's filesystem incarnation before native reconnect", async () => {
    const fixture = suspendableSandbox();
    const provider = createTangleProvider({ client: fixture.client, requireNativeSessionCapture: true });
    const environment = await provider.create({ profile });
    const box = (await fixture.client.get(environment.id))!;
    let ready = false;
    let waits = 0;
    box.backend = {
      status: async () => {
        if (!ready) throw http(409, "Sandbox filesystem incarnation is not ready");
        return { type: "claude-code" };
      },
    };
    box.waitFor = async () => { waits++; ready = true; };

    const reconnected = await provider.get!(environment.id);
    expect(reconnected).not.toBeNull();
    expect(waits).toBe(1);
    expect(fixture.counts.resumes).toBe(0);
  });

  it("refuses a stopped sandbox the linked client cannot resume", async () => {
    const fixture = suspendableSandbox();
    const provider = createTangleProvider({ client: fixture.client, requireNativeSessionCapture: true });
    const environment = await provider.create({ profile });
    const box = (await fixture.client.get(environment.id))!;
    delete box.resume;
    fixture.suspend();
    await expect(provider.get!(environment.id)).rejects.toThrow(/is stopped and the linked client cannot resume it/);
  });
});

import type { AgentWorkspaceSnapshotRef } from "@tangle-network/agent-interface";
import type { AgentEnvironment, AgentEnvironmentProvider, CreateAgentEnvironmentInput } from "@tangle-network/agent-interface/environment-provider";
import { AgentEnvironmentCapabilitiesSchema, WorkspaceRequestSchema } from "@tangle-network/agent-interface/environment-provider";
import { withEnvironmentCleanup } from "./conformance-helpers.js";

export interface WorkspaceSnapshotConformanceOptions {
  name: string;
  createProvider(): AgentEnvironmentProvider | Promise<AgentEnvironmentProvider>;
  createInput?: Partial<CreateAgentEnvironmentInput>;
  /** Required to qualify an advertised receiver through its real artifact store and workspace. */
  snapshot?: {
    request: AgentWorkspaceSnapshotRef;
    verify(environment: AgentEnvironment): Promise<void>;
  };
  /** Credentials, provisioning and native admission must remain unchanged on refusal. */
  effectCount?(): number | Promise<number>;
}

/** Check restore evidence when supported, or refusal before effects after adapter reconstruction. */
export async function runWorkspaceSnapshotConformance(options: WorkspaceSnapshotConformanceOptions): Promise<{ checked: string[] }> {
  const provider = await options.createProvider();
  const capabilities = AgentEnvironmentCapabilitiesSchema.parse(await provider.capabilities());
  const input: CreateAgentEnvironmentInput = {
    profile: { name: `${options.name}-workspace-snapshot` },
    ...options.createInput,
    workspace: options.snapshot === undefined ? { snapshot: refusalFixture() } :
      WorkspaceRequestSchema.parse({ ...options.createInput?.workspace, snapshot: options.snapshot.request }),
  };
  // A different unsupported field must not make a provider look snapshot-safe.
  delete input.idempotencyKey;
  if (capabilities.create?.workspaceSnapshot === true) {
    const fixture = options.snapshot;
    if (fixture === undefined) throw new Error("workspace snapshot capability requires a restore fixture and verification");
    const environment = await provider.create(input);
    return withEnvironmentCleanup(environment, [], async () => {
      if (await environment.status() !== "running") throw new Error("workspace snapshot receiver returned before it was ready");
      await fixture.verify(environment);
      return { checked: ["workspace-snapshot-restore"] };
    });
  }
  const before = await options.effectCount?.();
  for (const candidate of [provider, await options.createProvider()]) {
    let unexpected: AgentEnvironment | undefined;
    let refused = false;
    try {
      unexpected = await candidate.create(input);
    } catch (error) {
      refused = error instanceof Error && /workspace snapshot/i.test(error.message) && /support/i.test(error.message);
    } finally {
      await unexpected?.destroy?.();
    }
    if (!refused) throw new Error("unsupported portable workspace snapshot must be refused explicitly before allocation");
  }
  if (before !== undefined && await options.effectCount?.() !== before) throw new Error("unsupported workspace snapshot caused credentials, allocation or admission effects");
  return { checked: ["workspace-snapshot-refusal", ...(before === undefined ? [] : ["workspace-snapshot-zero-effects"])] };
}

function refusalFixture(): AgentWorkspaceSnapshotRef {
  const hash = (value: string) => `sha256:${value.repeat(64)}` as const;
  const artifact = (value: string) => ({ locator: { kind: "private-cas" as const, namespace: "snapshot-refusal-fixture", digest: hash(value) }, sha256: hash(value), byteLength: 128 });
  return {
    kind: "agent-candidate-workspace-snapshot",
    digest: hash("a"),
    manifest: artifact("a"),
    archive: artifact("b"),
    source: {
      leaseId: "source-lease", leaseRecordDigest: hash("c"),
      workspace: { provider: "source", root: "/workspace/source", identityDigest: hash("d") },
      sourceSnapshotDigest: hash("e"),
      sourceSnapshotPolicy: { kind: "provider-declared", name: "fixture-policy", version: 1, digest: hash("f") },
    },
  };
}

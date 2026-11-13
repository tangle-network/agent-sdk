import type { RetainedWorkspacePublication } from "@tangle-network/sandbox";
import {
  AgentRetainedFileOutputRequestSchema,
  AgentRetainedFileOutputResultSchema,
  type AgentRetainedFileOutputRequest,
  type AgentRetainedFileOutputResult,
} from "@tangle-network/agent-interface/environment-provider";
import type { AgentEnvironment } from "@tangle-network/agent-interface/environment-provider";
import { tangleEvidenceCredentialPath } from "./tangle-evidence-omission.js";
import { currentTangleControlRef, sameRunControlRef } from "./tangle-session-control.js";
import type { SandboxInstanceLike } from "./tangle-types.js";

const unavailable = (reason: string): AgentRetainedFileOutputResult => ({ status: "unavailable", reason });

/** References only: Sandbox performs the stopped capture and owns every byte and revision. */
export async function retainTangleFileOutput(
  environment: AgentEnvironment,
  box: SandboxInstanceLike,
  sourceCreatedAt: string,
  retainedPaths: readonly string[],
  raw: AgentRetainedFileOutputRequest,
  options?: { signal?: AbortSignal; idempotencyKey?: string },
): Promise<AgentRetainedFileOutputResult> {
  const { controlRef, policy } = AgentRetainedFileOutputRequestSchema.parse(raw);
  const current = currentTangleControlRef(environment);
  if (!current || !sameRunControlRef(current, controlRef) ||
      controlRef.environmentId !== box.id || controlRef.provider !== environment.provider)
    return unavailable("The original execution is not this handle's current admitted source");
  if (!box.stop || !environment.creation || tangleEvidenceCredentialPath(policy.path))
    return unavailable("The declared output has no owned retained-stop publication authority");
  options?.signal?.throwIfAborted();
  try {
    const publication: RetainedWorkspacePublication = await box.stop({
      retain: { paths: [...new Set([...retainedPaths, policy.path])], publication: true },
      wait: true,
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    });
    const after = currentTangleControlRef(environment);
    if (!after || !sameRunControlRef(after, current) || !publication ||
        publication.sandboxId !== box.id ||
        Date.parse(publication.sourceCreatedAt) !== Date.parse(sourceCreatedAt))
      return unavailable("The stopped publication did not retain the original physical source");
    const files = publication.files.filter((file) => file.sourcePath === policy.path);
    const file = files[0];
    if (files.length !== 1 || !file || file.runId !== publication.runId ||
        file.sandboxId !== box.id || file.workspaceSnapshot !== publication.workspaceSnapshot ||
        file.sourceKind !== "regular" || file.preserved !== true || !file.etag ||
        file.sourceSha256 !== file.storedSha256 || file.sourceBytes !== file.storedBytes)
      return unavailable("The declared file has no exact preserved regular-file revision");
    return AgentRetainedFileOutputResultSchema.parse({
      status: "published",
      publication: {
        controlRef: current,
        policy,
        source: {
          environmentId: publication.sandboxId,
          createdAt: publication.sourceCreatedAt,
          filesystemIncarnationId: publication.filesystemIncarnationId,
          workspaceSnapshot: publication.workspaceSnapshot,
        },
        file: { path: policy.path, kind: "regular", sha256: file.sourceSha256, byteLength: file.sourceBytes },
        providerReference: { ...publication },
        preserved: true,
      },
    });
  } catch {
    // No retry here: a missing original acknowledgment cannot authorize capturing a later source.
    return unavailable("The original stopped-file publication could not be verified");
  }
}

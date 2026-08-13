import { sessionPromptRequestDigest } from "./tangle-environment-control.js";
import {
  retainedSessionControlRef,
  sessionPromptExecutionId,
  sessionPromptSessionId,
} from "./tangle-session-control.js";
import type {
  SandboxInstanceLike,
  SandboxRuntimeCapabilityDocument,
  SandboxSessionLike,
} from "./tangle-types.js";

export const TANGLE_PROVIDER = "tangle-sandbox";

/**
 * A deployment that reports every retained-control flag. Fixtures that expect
 * exact dispatch or canonical cancellation must serve this document, because
 * the adapter reads the deployment before it offers either operation.
 */
export const RETAINED_DEPLOYMENT_DOCUMENT: SandboxRuntimeCapabilityDocument = {
  schema: 1,
  agentInterface: "0.49.0",
  sidecarVersion: "1.0.0-test",
  image: `example/sidecar@sha256:${"a".repeat(64)}`,
  dispatch: { runControlRef: true, executionIdOnAdmission: true },
  cancel: { canonicalRunCancellation: true, digestBound: true, idempotent: true },
  runs: { executionScopedStatus: true, eventReplay: true },
};

/**
 * Give a fake sandbox the running status and capability document a retained
 * deployment serves. Without both, the adapter reads no deployment truth and
 * claims no retained control.
 */
export function retainedDeployment(
  box: SandboxInstanceLike,
  document: SandboxRuntimeCapabilityDocument | null = RETAINED_DEPLOYMENT_DOCUMENT,
): SandboxInstanceLike {
  return {
    ...box,
    status: box.status ?? "running",
    capabilities: async () => document,
  };
}

/**
 * The session surface a sandbox behind a retained deployment carries. A
 * fixture that dispatches needs one: a detached run is reachable only through
 * a session handle, so the adapter claims no detach without it.
 */
export function retainedSessionHandle(id: string): SandboxSessionLike {
  return {
    id,
    status: async () => ({ status: "running" }),
    async *events() {},
    result: async (options) => ({
      success: true,
      status: "success",
      executionId: options?.executionId,
      durationMs: 1,
    }),
    prompt: async (_message, options) => ({
      success: true,
      status: "success",
      executionId: options?.executionId,
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

export { sessionPromptSessionId };

type SemanticTurnInput = Parameters<typeof sessionPromptRequestDigest>[0];

export function executionIdForTurn(
  input: SemanticTurnInput,
  environmentId: string,
  sessionId: string,
) {
  return sessionPromptExecutionId(
    sessionPromptRequestDigest(
      input,
      TANGLE_PROVIDER,
      environmentId,
      sessionId,
    ),
  );
}

export function controlRefForTurn(
  input: SemanticTurnInput,
  environmentId: string,
  sessionId: string,
) {
  const baseRequestDigest = sessionPromptRequestDigest(
    input,
    TANGLE_PROVIDER,
    environmentId,
    sessionId,
  );
  const executionId = sessionPromptExecutionId(baseRequestDigest);
  const requestDigest = sessionPromptRequestDigest(
    input,
    TANGLE_PROVIDER,
    environmentId,
    sessionId,
    { executionId },
  );
  return retainedSessionControlRef(
    sessionId,
    executionId,
    TANGLE_PROVIDER,
    environmentId,
    requestDigest,
  );
}

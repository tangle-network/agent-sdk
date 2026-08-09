import { createHash, randomUUID } from "node:crypto";
import {
  AgentExactRunControlRefSchema,
  canonicalCandidateDigest,
} from "@tangle-network/agent-interface";
import type { AgentRunControlRef } from "@tangle-network/agent-interface";
import type { AgentSessionRef } from "@tangle-network/agent-interface/environment-provider";
import { nonEmptyString } from "./tangle-environment-values.js";
import {
  assertBoundedJson,
  boundedIdentifier,
} from "./tangle-contract-safety.js";

export function sessionRefFromSandboxDispatch(
  dispatched: unknown,
  providerName: string,
  environmentId: string,
  expectedExecutionId: string | undefined,
  requestDigest: `sha256:${string}` | undefined = undefined,
  expectedSessionId: string | undefined = undefined,
): AgentSessionRef {
  const record =
    dispatched && typeof dispatched === "object" && !Array.isArray(dispatched)
      ? (dispatched as Record<string, unknown>)
      : undefined;
  if (record) assertBoundedJson(record);
  const id = record?.sessionId ?? record?.id;
  if (!record || typeof id !== "string") {
    throw new Error("sandbox dispatch returned no session id");
  }
  boundedIdentifier(id, "Tangle dispatched session id");
  if (expectedSessionId !== undefined && id !== expectedSessionId) {
    throw new Error(
      "sandbox dispatch returned a session id different from the requested session",
    );
  }
  const executionId = nonEmptyString(record.executionId);
  if (executionId === undefined) {
    throw new Error(
      "sandbox dispatch returned no exact execution id for durable replay",
    );
  }
  if (
    expectedExecutionId !== undefined &&
    executionId !== expectedExecutionId
  ) {
    throw new Error(
      "sandbox dispatch returned an execution id different from the requested run",
    );
  }
  boundedIdentifier(executionId, "Tangle dispatched execution id");
  if (record.status !== undefined && typeof record.status !== "string") {
    throw new Error("sandbox dispatch returned an invalid status");
  }
  if (record.alreadyExisted !== undefined && typeof record.alreadyExisted !== "boolean") {
    throw new Error("sandbox dispatch returned an invalid alreadyExisted flag");
  }
  if (record.dispatched !== undefined && typeof record.dispatched !== "boolean") {
    throw new Error("sandbox dispatch returned an invalid dispatched flag");
  }
  return {
    id,
    provider: providerName,
    controlRef: retainedSessionControlRef(
      id,
      executionId,
      providerName,
      environmentId,
      requestDigest ??
        canonicalCandidateDigest({ provider: providerName, environmentId, id, executionId }),
    ),
    metadata: {
      ...(record.status ? { status: record.status } : {}),
      ...(record.alreadyExisted !== undefined ? { alreadyExisted: record.alreadyExisted } : {}),
      ...(record.dispatched !== undefined ? { dispatched: record.dispatched } : {}),
    },
  };
}

export function retainedSessionControlRef(
  sessionId: string,
  executionId: string,
  provider: string,
  environmentId: string,
  requestDigest?: `sha256:${string}`,
): AgentRunControlRef {
  return AgentExactRunControlRefSchema.parse({
    runId: executionId,
    provider,
    environmentId,
    sessionId,
    executionId,
    requestDigest:
      requestDigest ??
      canonicalCandidateDigest({ provider, environmentId, sessionId, executionId }),
  });
}

export function sessionPromptExecutionId(
  provider: string,
  environmentId: string,
  sessionId: string,
  turnId: string | undefined,
): string {
  if (turnId === undefined) return randomUUID();
  const digest = createHash("sha256")
    .update(`${provider}\0${environmentId}\0${sessionId}\0${turnId}`)
    .digest("hex");
  return `session-turn-${digest}`;
}

export function sameRunControlRef(
  left: AgentRunControlRef,
  right: AgentRunControlRef,
): boolean {
  return (
    left.runId === right.runId &&
    left.provider === right.provider &&
    left.environmentId === right.environmentId &&
    left.sessionId === right.sessionId &&
    left.executionId === right.executionId &&
    left.requestDigest === right.requestDigest
  );
}

export function resolveRetainedSessionControlRef(
  candidate: AgentRunControlRef | undefined,
  sessionId: string,
  provider: string,
  environmentId: string,
): AgentRunControlRef | undefined {
  if (candidate === undefined) return undefined;
  const controlRef = AgentExactRunControlRefSchema.parse(candidate);
  if (
    controlRef.provider !== provider ||
    controlRef.environmentId !== environmentId ||
    controlRef.sessionId !== sessionId
  ) {
    throw new Error("Tangle control reference does not match this session");
  }
  if (
    controlRef.runId !== controlRef.executionId
  ) {
    throw new Error(
      "Tangle session control reference requires runId to equal executionId",
    );
  }
  return controlRef;
}

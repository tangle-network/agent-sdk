import { sessionPromptRequestDigest } from "./tangle-environment-control.js";
import {
  retainedSessionControlRef,
  sessionPromptExecutionId,
  sessionPromptSessionId,
} from "./tangle-session-control.js";

export const TANGLE_PROVIDER = "tangle-sandbox";

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

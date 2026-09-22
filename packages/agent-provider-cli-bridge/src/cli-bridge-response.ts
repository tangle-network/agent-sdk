import { readBoundedUtf8Body, safeJson } from "./cli-bridge-sse.js";
import { preserveRootError } from "./cli-bridge-limits.js";
import type {
  CliBridgeResponse,
  CliBridgeRun,
} from "./cli-bridge-types.js";

export interface CliBridgeUnknownRunResult {
  readonly kind: "cli-bridge-unknown-run";
  readonly status: "unknown";
  readonly reason: "response-identity-mismatch";
}

export class CliBridgeRunIdentityError extends Error {
  readonly result: CliBridgeUnknownRunResult = {
    kind: "cli-bridge-unknown-run",
    status: "unknown",
    reason: "response-identity-mismatch",
  };

  constructor() {
    super("cli-bridge could not authenticate the returned run identity");
    this.name = "CliBridgeRunIdentityError";
  }
}

export function captureCliBridgeRunIdentity(
  response: CliBridgeResponse,
  run: CliBridgeRun,
): void {
  const responseRunId = response.headers.get("x-run-id");
  const requestDigest = response.headers.get("x-run-request-digest");
  if (responseRunId !== run.id) {
    throw new CliBridgeRunIdentityError();
  }
  if (
    requestDigest !== null &&
    run.requestDigest !== undefined &&
    requestDigest !== run.requestDigest
  ) {
    throw new CliBridgeRunIdentityError();
  }
  if (run.requestDigest !== undefined && requestDigest === null) {
    throw new CliBridgeRunIdentityError();
  }
  if (requestDigest !== null) run.requestDigest = requestDigest;
}

export function acceptCliBridgeResponse(
  response: CliBridgeResponse,
  requestBody: string,
  onAccepted: ((response: CliBridgeResponse) => void) | undefined,
): void {
  if (onAccepted) {
    onAccepted(response);
    return;
  }
  const body = safeJson(requestBody);
  const requestedRunId = body?.run_id;
  if (
    typeof requestedRunId !== "string" ||
    response.headers.get("x-run-id") !== requestedRunId
  ) {
    throw new CliBridgeRunIdentityError();
  }
}

export async function detachCliBridgeReader(
  body: AsyncIterable<Uint8Array>,
): Promise<void> {
  const cancellable = body as AsyncIterable<Uint8Array> & {
    cancel?: (reason?: unknown) => Promise<void>;
  };
  if (cancellable.cancel) {
    await cancellable.cancel();
    return;
  }
  const iterator = body[Symbol.asyncIterator]();
  if (!iterator.return) {
    throw new Error("cli-bridge response body cannot detach its reader");
  }
  await iterator.return();
}

export async function readCliBridgeResponseText(
  response: CliBridgeResponse,
): Promise<string> {
  if (!response.body) return "";
  try {
    return await readBoundedUtf8Body(response.body);
  } catch (error) {
    try {
      await detachCliBridgeReader(response.body);
    } catch (detachError) {
      throw preserveRootError(
        error,
        detachError,
        "cli-bridge response reader cleanup failed",
      );
    }
    throw error;
  }
}

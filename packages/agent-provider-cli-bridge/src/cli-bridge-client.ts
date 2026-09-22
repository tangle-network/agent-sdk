import type { AgentSessionStatus } from "@tangle-network/agent-interface/environment-provider";
import { boundedErrorDetail } from "./cli-bridge-limits.js";
import {
  detachCliBridgeReader,
  readCliBridgeResponseText,
} from "./cli-bridge-response.js";
export {
  captureCliBridgeRunIdentity,
  CliBridgeRunIdentityError,
  detachCliBridgeReader,
  readCliBridgeResponseText,
} from "./cli-bridge-response.js";
export type { CliBridgeUnknownRunResult } from "./cli-bridge-response.js";
import {
  assertCliBridgeRunSnapshotIdentity,
  cancelSnapshot,
  runSnapshot,
} from "./cli-bridge-snapshots.js";
import { requestHeaders, trimSlash } from "./cli-bridge-transport.js";
import type {
  CliBridgeProviderOptions,
  CliBridgeRun,
  CliBridgeRunSnapshot,
  CliBridgeTransport,
} from "./cli-bridge-types.js";

export { readFullCliBridgeResult } from "./cli-bridge-result.js";
export {
  CliBridgeRequestRejectedError,
  streamCliBridgeTurn,
} from "./cli-bridge-stream.js";

export async function cancelCliBridgeRun(
  options: CliBridgeProviderOptions,
  transport: CliBridgeTransport,
  run: CliBridgeRun,
): Promise<CliBridgeRunSnapshot> {
  if (run.cancellation) return run.cancellation;
  run.cancellation = (async () => {
    const response = await transport.fetch(
      `${trimSlash(options.baseUrl)}/v1/runs/${encodeURIComponent(run.id)}/cancel`,
      {
        method: "POST",
        headers: requestHeaders(options),
        body: "{}",
      },
    );
    if (!response.ok) {
      throw new Error(
        `cli-bridge cancel ${response.status}: ${boundedErrorDetail(
          await readCliBridgeResponseText(response),
        )}`,
      );
    }
    let snapshot: CliBridgeRunSnapshot | null = cancelSnapshot(
      await readCliBridgeResponseText(response),
    );
    assertCliBridgeRunSnapshotIdentity(snapshot, run.id);
    const waitBudgetMs = options.cancelWaitMs ?? 30_000;
    const deadline = Date.now() + waitBudgetMs;
    while (!snapshot.terminal) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      snapshot = await getCliBridgeRun(
        options,
        transport,
        run.id,
        Math.min(remainingMs, 30_000),
      );
      if (snapshot === null) {
        throw new Error(
          `cli-bridge lost run "${run.id}" before confirming cancellation`,
        );
      }
    }
    if (!snapshot.terminal) {
      throw new Error(
        `cli-bridge run "${run.id}" did not confirm terminal cancellation`,
      );
    }
    for (const reader of run.readers) {
      reader.abort(
        new DOMException(
          `cli-bridge run ended ${snapshot.status}`,
          "AbortError",
        ),
      );
    }
    return snapshot;
  })();
  try {
    return await run.cancellation;
  } finally {
    run.cancellation = undefined;
  }
}

export async function getCliBridgeRun(
  options: CliBridgeProviderOptions,
  transport: CliBridgeTransport,
  runId: string,
  waitMs?: number,
): Promise<CliBridgeRunSnapshot | null> {
  const query = waitMs === undefined ? "" : `?wait_ms=${waitMs}`;
  const response = await transport.fetch(
    `${trimSlash(options.baseUrl)}/v1/runs/${encodeURIComponent(runId)}${query}`,
    {
      method: "GET",
      headers: requestHeaders(options),
    },
  );
  if (response.status === 404) {
    if (response.body) await detachCliBridgeReader(response.body);
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `cli-bridge run status ${response.status}: ${boundedErrorDetail(
        await readCliBridgeResponseText(response),
      )}`,
    );
  }
  const snapshot = runSnapshot(await readCliBridgeResponseText(response));
  assertCliBridgeRunSnapshotIdentity(snapshot, runId);
  return snapshot;
}

export function agentSessionStatusFromRun(
  snapshot: CliBridgeRunSnapshot,
): AgentSessionStatus {
  if (snapshot.status === "done") return "completed";
  if (snapshot.status === "error") return "failed";
  if (snapshot.status === "cancelled") return "cancelled";
  return "running";
}



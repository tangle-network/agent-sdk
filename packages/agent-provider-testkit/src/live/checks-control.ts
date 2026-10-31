import type { AgentEnvironment } from "@tangle-network/agent-interface/environment-provider";
import { errorSummary, harnessProcess, listRun, RUN_TAG_KEY, until, type LiveContext } from "./context.js";
import { describeError, finalText, observeTurn, waitMs, turnOutcome } from "./turns.js";

const SLEEP_TASK = (seconds: number): string => `Run the shell command \`sleep ${seconds}\` with your Bash tool and wait for it to finish, then reply with exactly DONE.`;

/** Processes whose command line contains `text`. The first character is bracketed so the probe's own shell never matches. */
async function processCount(environment: AgentEnvironment, text: string): Promise<number> {
  const result = await environment.exec?.(`pgrep -f -c -- '[${text[0]}]${text.slice(1)}' || true`);
  return Number((result?.stdout ?? "0").trim() || "0");
}

/** CAN-1: aborting the turn kills the harness process tree, rejects with AbortError and leaves the sandbox usable. */
export async function checkAbort(ctx: LiveContext, environment: AgentEnvironment): Promise<void> {
  const { rec } = ctx;
  const proc = harnessProcess(ctx.options);
  const controller = new AbortController();
  const started = Date.now();
  let abortedAt: number | undefined;
  let afterAbort = 0;
  let error: unknown;
  try {
    for await (const event of environment.stream({ prompt: SLEEP_TASK(301), sessionId: `${ctx.runTag}-abort`, signal: controller.signal })) {
      // Abort at the first event the harness produced, not at the provider's own start marker.
      if (abortedAt === undefined && event.type === "execution.started") continue;
      if (abortedAt === undefined) {
        abortedAt = Date.now();
        controller.abort();
      } else if (Date.now() - abortedAt > 500) afterAbort += 1;
    }
  } catch (caught) {
    error = caught;
  }
  const aborted = error instanceof Error && error.name === "AbortError";
  rec.observe("CAN-1", aborted, aborted ? `the iterator rejected with AbortError ${Date.now() - started} ms after the turn began` : `abort did not reject with AbortError: ${error === undefined ? "the stream ended normally" : describeError(error)}`);
  rec.observe("CAN-1", afterAbort === 0, afterAbort === 0 ? "no event followed the abort" : `${afterAbort} events followed the abort`);
  const gone = await until(async () => (await processCount(environment, "sleep 301")) === 0, 30_000);
  rec.observe("CAN-1", gone, gone ? "the tool process tree was gone within 30 s" : "the sleep process survived the abort for 30 s");
  if (proc !== undefined) {
    const harnessGone = await until(async () => Number((await environment.exec?.(`pgrep -c ${proc[0]} -- '${proc[1]}' || true`))?.stdout.trim() || "0") === 0, 30_000);
    rec.observe("CAN-1", harnessGone, harnessGone ? "the harness process was gone within 30 s" : "the harness process survived the abort for 30 s");
  }
  const usable = await environment.exec?.("echo ok");
  rec.observe("CAN-1", usable?.stdout.trim() === "ok", "exec still works after the abort");
}

/** CAN-2: exec honors timeoutMs and signal by ending the remote command. */
export async function checkExecCancel(ctx: LiveContext, environment: AgentEnvironment): Promise<void> {
  const { rec } = ctx;
  if (typeof environment.exec !== "function") return;
  const timed = Date.now();
  const outcome = await environment.exec("sleep 302", { timeoutMs: 3_000 }).then(() => "returned", (error: unknown) => describeError(error));
  const elapsed = Date.now() - timed;
  const timedGone = await until(async () => (await processCount(environment, "sleep 302")) === 0, 20_000);
  rec.observe("CAN-2", elapsed < 30_000 && timedGone, `timeoutMs: ${outcome} after ${elapsed} ms; the remote command ${timedGone ? "ended" : "kept running"}`);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 2_000);
  const aborted = await environment.exec("sleep 303", { signal: controller.signal }).then(() => "returned", (error: unknown) => (error instanceof Error ? error.name : "error"));
  const signalGone = await until(async () => (await processCount(environment, "sleep 303")) === 0, 20_000);
  rec.observe("CAN-2", signalGone, `signal: ${aborted}; the remote command ${signalGone ? "ended" : "kept running"}`);
}

/** TRN-8 and USE-4: timeoutMs kills the run and the terminal event names the timeout. */
export async function checkTimeout(ctx: LiveContext, environment: AgentEnvironment): Promise<void> {
  const { rec } = ctx;
  const limit = 25_000;
  const turn = await observeTurn(environment, { prompt: SLEEP_TASK(304), sessionId: `${ctx.runTag}-timeout`, timeoutMs: limit });
  const text = turn.terminals.map((event) => `${String(event.data.error ?? "")} ${String(event.data.errorCode ?? "")} ${String(event.data.detail ?? "")}`).join(" ");
  const named = /time(d)?[ -]?out/i.test(text);
  const failed = turnOutcome(turn) === "failed";
  rec.observe("TRN-8", failed && named && turn.durationMs < limit + 60_000, turn.terminals.length === 0 ? `no terminal event (${turn.error === undefined ? "stream ended" : errorSummary(turn.error)})` : `outcome ${turnOutcome(turn)} after ${turn.durationMs} ms: ${text.trim().slice(0, 120)}`);
  const gone = await until(async () => (await processCount(environment, "sleep 304")) === 0, 30_000);
  rec.observe("TRN-8", gone, gone ? "the process tree was killed at the timeout" : "the sleep process survived the timeout");
  const usageFrames = turn.events.filter((entry) => entry.event.usage !== undefined);
  const lastIsTerminal = turn.terminals.some((event) => event.usage !== undefined);
  rec.observe("USE-4", usageFrames.length === 0 || lastIsTerminal, usageFrames.length === 0 ? "no usage frame preceded the failure, so none is owed" : lastIsTerminal ? "the failed terminal event carries the usage observed so far" : "usage frames preceded the failure but the terminal event carries none");
  rec.unproven("TDN-4", "the vendor sandbox lifetime and run tag are read from the vendor account, not through the provider seam");
}

/** TRN-10: a second turn while one runs is refused or serialized, never interleaved. */
export async function checkBusyEnvironment(ctx: LiveContext, environment: AgentEnvironment): Promise<void> {
  const { rec } = ctx;
  const first = observeTurn(environment, { prompt: SLEEP_TASK(15), sessionId: `${ctx.runTag}-busy-a`, timeoutMs: 120_000 }).then((turn) => ({ turn, endedAt: Date.now() }));
  await waitMs(8_000);
  const secondStarted = Date.now();
  const second = await observeTurn(environment, { prompt: "Reply with exactly PONG.", sessionId: `${ctx.runTag}-busy-b`, timeoutMs: 120_000 });
  const { turn: firstTurn, endedAt } = await first;
  if (second.error !== undefined && second.events.length === 0) {
    rec.pass("TRN-10", `the second turn was refused: ${errorSummary(second.error)}`);
    return;
  }
  const secondFirstEvent = secondStarted + (second.events[0]?.atMs ?? 0);
  const serialized = second.events.length > 0 && secondFirstEvent >= endedAt - 1_000 && turnOutcome(firstTurn) === "completed";
  rec.observe("TRN-10", serialized, serialized ? `the second turn ran after the first settled (first event ${secondFirstEvent - endedAt} ms after the first turn ended)` : `the second turn interleaved with the first: its first event came ${endedAt - secondFirstEvent} ms before the first turn ended (${second.events.length} events, reply ${JSON.stringify(finalText(second).slice(0, 40))})`);
}

/** CAN-4: destroy resolves while a harness runs, and the in-flight stream ends. */
export async function checkDestroyMidTurn(ctx: LiveContext): Promise<void> {
  const { rec } = ctx;
  let environment: AgentEnvironment | undefined;
  try {
    environment = await ctx.create({}, "destroy-mid-turn");
    const running = observeTurn(environment, { prompt: SLEEP_TASK(305), sessionId: `${ctx.runTag}-destroy`, timeoutMs: 120_000 });
    await waitMs(15_000);
    const destroyed = await environment.destroy?.().then(() => true, (error: unknown) => describeError(error));
    rec.observe("CAN-4", destroyed === true, destroyed === true ? "destroy resolved while a harness was running" : `destroy while a turn ran: ${String(destroyed)}`);
    const ended = await Promise.race([running.then(() => true), waitMs(60_000).then(() => false)]);
    rec.observe("CAN-4", ended, ended ? "the in-flight stream ended after destroy" : "the in-flight stream was still open 60 s after destroy");
  } catch (error) {
    rec.fail("CAN-4", `could not run the destroy-mid-turn probe: ${errorSummary(error)}`);
  }
}

/** CAN-3 and TDN-3: an abort during create, and a failure after the vendor create, leave no sandbox. */
export async function checkCreateFailures(ctx: LiveContext): Promise<void> {
  const { rec } = ctx;
  const abortTag = `${ctx.runTag}-abort-create`;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const aborted = await ctx.provider.create({ profile: ctx.profile, ...(ctx.options.createInput ?? {}), metadata: { [RUN_TAG_KEY]: ctx.runTag, "conformance-case": abortTag }, signal: controller.signal }).then(
    async (environment) => {
      ctx.environments.push(environment);
      return "created";
    },
    (error: unknown) => (error instanceof Error && error.name === "AbortError" ? "AbortError" : describeError(error)),
  );
  rec.observe("CAN-3", aborted === "AbortError" || aborted === "created", `create aborted at 0.3 s: ${aborted}`);
  const failTag = `${ctx.runTag}-clone-fails`;
  const failed = await ctx.expectRefusal({ workspace: { repoUrl: `https://github.com/tangle-network/conformance-no-such-repository-${ctx.runTag}.git` }, metadata: { [RUN_TAG_KEY]: ctx.runTag, "conformance-case": failTag } }, "clone-fails");
  rec.observe("TDN-3", failed.refused, failed.refused ? `a clone failure fails create: ${errorSummary(failed.error)}` : "create succeeded for a repository that does not exist");
  if (failed.refused) ctx.refusals.push(failed.error);
  const listed = await listRun(ctx);
  if (listed === undefined) rec.unproven("CAN-3", "the provider has no list, so a late-arriving sandbox cannot be read from the vendor side");
}

/** CON-1: parallel create, turn and destroy on one provider instance. */
export async function checkConcurrency(ctx: LiveContext): Promise<void> {
  const { rec } = ctx;
  const count = ctx.options.concurrency ?? 4;
  const cycles = await Promise.allSettled(
    Array.from({ length: count }, async (_, index) => {
      const environment = await ctx.create({}, `concurrent-${index}`);
      const turn = await observeTurn(environment, { prompt: `Reply with exactly PONG-${index}.`, sessionId: `${ctx.runTag}-par-${index}`, timeoutMs: 180_000 });
      await environment.destroy?.();
      return finalText(turn).includes(`PONG-${index}`);
    }),
  );
  const failures = cycles.filter((cycle) => cycle.status === "rejected" || cycle.value !== true);
  rec.observe("CON-1", failures.length === 0, failures.length === 0 ? `${count} parallel create, turn and destroy cycles settled on one provider` : `${failures.length} of ${count} parallel cycles failed: ${failures.map((failure) => (failure.status === "rejected" ? errorSummary(failure.reason) : "wrong reply")).join("; ").slice(0, 300)}`);
}

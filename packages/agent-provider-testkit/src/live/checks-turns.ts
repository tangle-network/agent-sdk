import { isEnvironmentProviderError, type AgentEnvironment } from "@tangle-network/agent-interface/environment-provider";
import { deniedFile, hookLog, mcpLog, mcpServerPath, mcpServerSource, probeTasks } from "./probe-profile.js";
import { errorSummary, namesField, type LiveContext } from "./context.js";
import { eventSchemaIssues, finalText, observeTurn, servedModel, turnOutcome, type TurnObservation } from "./turns.js";

const TURN_TIMEOUT_MS = 240_000;
const COST_PROVENANCE = new Set(["billing-receipt", "provider-receipt", "catalog-estimate", "uncaptured"]);

export interface Observed {
  name: string;
  turn: TurnObservation;
}

function turnInput(ctx: LiveContext, prompt: string, name: string): { prompt: string; sessionId: string; timeoutMs: number } {
  return { prompt, sessionId: `${ctx.runTag}-${name}`, timeoutMs: TURN_TIMEOUT_MS };
}

/** A file's text read through exec, so the probe does not depend on the file API's root. */
async function fileText(environment: AgentEnvironment, path: string): Promise<string | undefined> {
  const result = await environment.exec?.(`cat -- '${path}'`).catch(() => undefined);
  return result?.exitCode === 0 ? result.stdout : undefined;
}

/** Per-turn checks every turn must pass: TRN-4 shape, TRN-5, TRN-6, TRN-7. */
function checkTurnShape(ctx: LiveContext, observed: Observed): void {
  const { rec } = ctx;
  const { name, turn } = observed;
  if (turn.error !== undefined) {
    rec.fail("TRN-6", `${name}: the stream rejected: ${errorSummary(turn.error)}`);
    return;
  }
  rec.observe("TRN-6", turn.terminals.length === 1, `${name}: ${turn.terminals.length} terminal-class events (${turn.terminals.map((entry) => entry.type).join(", ")})`);
  const outcome = turnOutcome(turn);
  rec.observe("TRN-6", outcome === "completed", `${name}: turn outcome ${outcome}${outcome === "failed" ? `: ${String(turn.terminals.find((entry) => entry.data.error !== undefined || entry.data.detail !== undefined)?.data.error ?? turn.terminals.find((entry) => entry.data.detail !== undefined)?.data.detail ?? "").slice(0, 160)}` : ""}`);
  const issues = eventSchemaIssues(turn);
  rec.observe("TRN-5", turn.events.length > 0 && issues.length === 0, issues.length === 0 ? `${name}: ${turn.events.length} events match the event schema` : `${name}: ${issues[0]}`);
  const normalized = turn.events.filter((entry) => entry.event.normalized !== undefined).length;
  rec.observe("TRN-5", normalized > 0, `${name}: ${normalized} events carry a normalized canonical event`);
  const text = finalText(turn);
  rec.observe("TRN-7", text.trim().length > 0, `${name}: finalText ${text.trim().length} characters`);
}

function checkUsage(ctx: LiveContext, observed: Observed): void {
  const { rec, capabilities } = ctx;
  const { name, turn } = observed;
  const terminal = turn.terminals.at(-1);
  const usage = terminal?.usage;
  const complete = usage !== undefined && Number.isInteger(usage.inputTokens) && Number.isInteger(usage.outputTokens);
  rec.observe("USE-1", complete, complete ? `${name}: terminal usage in=${usage.inputTokens} out=${usage.outputTokens}, mode ${terminal?.usageMode ?? "unstated"}` : `${name}: the terminal event carries no usage with both token counts`);
  if (terminal?.usage !== undefined) rec.observe("USE-1", terminal.usageMode === "cumulative", `${name}: terminal usageMode is ${terminal.usageMode ?? "absent"}`);
  if (!capabilities.usage) rec.pass("CAP-6", `capabilities.usage is false, so no terminal event owes usage (${name})`);
  if (capabilities.usage) rec.observe("CAP-6", complete, `capabilities.usage is true and the ${name} terminal ${complete ? "carries" : "lacks"} usage`);
  const cumulative = turn.events.filter((entry) => entry.event.usageMode === "cumulative" && entry.event.usage !== undefined).map((entry) => entry.event.usage!);
  const monotone = cumulative.every((value, index) => index === 0 || (value.inputTokens >= cumulative[index - 1]!.inputTokens && value.outputTokens >= cumulative[index - 1]!.outputTokens));
  rec.observe("USE-3", monotone, `${name}: ${cumulative.length} cumulative usage events ${monotone ? "never decrease" : "decrease"}`);
  const priced = turn.events.filter((entry) => entry.event.usage?.cost !== undefined);
  if (priced.length === 0) {
    rec.pass("USE-2", `${name}: no dollar amount reported, so none is unprovenanced`);
    rec.pass("USE-5", `${name}: no dollar amount reported, so no vendor compute dollars entered usage.cost`);
  } else {
    const unmarked = priced.filter((entry) => !COST_PROVENANCE.has(String(entry.event.data.costProvenance ?? entry.event.data.cost_provenance)));
    rec.observe("USE-2", unmarked.length === 0, `${name}: ${priced.length} priced events, ${unmarked.length} without costProvenance`);
    rec.unproven("USE-5", "a dollar amount is reported; that it excludes vendor compute needs the vendor bill");
  }
}

function checkServedModel(ctx: LiveContext, observed: Observed): void {
  const served = servedModel(observed.turn);
  const declared = ctx.options.model;
  const matches = served !== undefined && (served === declared || served.endsWith(`/${declared}`) || declared.endsWith(`/${served}`));
  ctx.rec.observe("MOD-2", matches, served === undefined ? `${observed.name}: no event reports data.effectiveBackend.model` : `${observed.name}: served ${served} for declared ${declared}`);
  ctx.rec.observe("MOD-1", matches, `${observed.name}: the declared model ${declared} ${matches ? "is the served model" : "is not the served model"}`);
}

/** P3: one scripted task per profile axis, observed through the turn stream and read back from the workspace. */
export async function checkAxes(ctx: LiveContext, environment: AgentEnvironment): Promise<Observed[]> {
  const { rec, nonces, capabilities } = ctx;
  const tasks = probeTasks(nonces, ctx.runTag);
  const observed: Observed[] = [];
  const run = async (name: keyof typeof tasks | "shell", prompt: string): Promise<Observed> => {
    const turn = await observeTurn(environment, turnInput(ctx, prompt, name));
    const entry = { name, turn };
    observed.push(entry);
    ctx.log(`turn ${name}: ${turn.events.length} events in ${turn.durationMs} ms, ${turn.error === undefined ? `outcome ${turnOutcome(turn)}` : errorSummary(turn.error)}`);
    checkTurnShape(ctx, entry);
    checkUsage(ctx, entry);
    return entry;
  };

  const shell = await run("shell", `Do not run any commands. Reply with exactly the word PONG. ; touch /tmp/${nonces.shell} ;`);
  const ran = await environment.exec?.(`test -e /tmp/${nonces.shell}`);
  rec.observe("TRN-2", ran?.exitCode !== 0 && finalText(shell.turn).includes("PONG"), ran?.exitCode === 0 ? "the prompt text was executed as a shell command" : `the prompt was data: the harness replied ${JSON.stringify(finalText(shell.turn).slice(0, 40))} and no shell side effect exists`);

  const system = await run("system", tasks.system);
  checkServedModel(ctx, system);
  const systemOk = finalText(system.turn).includes(nonces.system);
  ctx.axes.system = systemOk;
  rec.observe("MAT-7", systemOk, systemOk ? "system prompt: the nonce only the prompt carries was returned" : "system prompt: the nonce was not returned");
  rec.observe("TRN-7", finalText(system.turn).trim() === nonces.system, `finalText is the final assistant message: ${JSON.stringify(finalText(system.turn).trim().slice(0, 60))}`);
  if (capabilities.profile.systemPrompt.append || capabilities.profile.systemPrompt.replace) rec.observe("CAP-4", systemOk, `system prompt flag ${systemOk ? "proven" : "claimed but the nonce was not returned"}`);

  const encoded = Buffer.from(mcpServerSource(mcpLog(ctx.runTag)), "utf8").toString("base64");
  await environment.exec?.(`printf %s '${encoded}' | base64 -d > '${mcpServerPath(ctx.runTag)}'`);
  await run("mcp", tasks.mcp);
  const mcpOk = (await fileText(environment, mcpLog(ctx.runTag)))?.includes(nonces.mcp) === true;
  ctx.axes.mcp = mcpOk;
  rec.observe("MAT-7", mcpOk, mcpOk ? "mcp: the probe server recorded the call" : "mcp: the probe server recorded no call");
  if (capabilities.profile.mcp) rec.observe("CAP-4", mcpOk, `mcp flag ${mcpOk ? "proven" : "claimed but no MCP call was recorded"}`);

  const hook = await run("hook", tasks.hook);
  const hookOk = (await fileText(environment, hookLog(ctx.runTag)))?.includes(nonces.hook) === true;
  ctx.axes.hook = hookOk;
  rec.observe("MAT-7", hookOk, hookOk ? "hooks: the hook marker was written by a tool call" : "hooks: no hook marker after a Bash tool call");
  rec.observe("CAP-4", hookOk === (capabilities.profile.hooks === true), `hooks flag is ${capabilities.profile.hooks === true} and the hook ${hookOk ? "fired" : "did not fire"}`);
  const perms = await run("deny", tasks.deny);
  const denied = await environment.exec?.(`test -e '${deniedFile(ctx.runTag)}'`);
  const deniedOk = denied?.exitCode !== 0;
  ctx.axes.deny = deniedOk;
  rec.observe("MAT-7", deniedOk, deniedOk ? "permissions: the denied Write left no file" : "permissions: the denied Write created the file");
  if (capabilities.profile.permissions) rec.observe("CAP-4", deniedOk, `permissions flag ${deniedOk ? "proven" : "claimed but the denied tool ran"}`);
  void perms;
  const sub = await run("subagent", tasks.subagent);
  const subOk = finalText(sub.turn).includes(nonces.child);
  ctx.axes.subagent = subOk;
  rec.observe("MAT-7", subOk, subOk ? "subagents: the child's token came back through delegation" : "subagents: the child's token was not returned");
  if (capabilities.profile.subagents) rec.observe("CAP-4", subOk, `subagents flag ${subOk ? "proven" : "claimed but delegation did not return the child's token"}`);
  void hook;

  const spread = [mcpOk, hookOk].some(Boolean) ? observed.find((entry) => entry.name === "mcp")?.turn : undefined;
  if (spread !== undefined && spread.events.length >= 3) {
    const first = spread.events[0]!.atMs;
    const last = spread.events.at(-1)!.atMs;
    rec.observe("TRN-4", first < last * 0.6 && last > 1_000, `events arrive as emitted: first at ${first} ms of ${last} ms across ${spread.events.length} events`);
  } else rec.unproven("TRN-4", "no multi-event turn completed to measure incremental arrival");
  return observed;
}

/** TRN-9 when the provider claims continuation: the same sessionId continues the conversation. */
export async function checkContinuation(ctx: LiveContext, environment: AgentEnvironment): Promise<void> {
  if (!ctx.capabilities.sessions.continue) {
    ctx.rec.pass("TRN-9", "continuation is not claimed (sessions.continue is false)");
    return;
  }
  const word = `word-${ctx.nonces.hook.toLowerCase()}`;
  const sessionId = `${ctx.runTag}-continue`;
  await observeTurn(environment, { prompt: `Remember this code word: ${word}. Reply with exactly OK.`, sessionId, timeoutMs: TURN_TIMEOUT_MS });
  const second = await observeTurn(environment, { prompt: "What code word did I ask you to remember? Reply with only the code word.", sessionId, timeoutMs: TURN_TIMEOUT_MS });
  ctx.rec.observe("TRN-9", finalText(second).includes(word), finalText(second).includes(word) ? "a repeated sessionId continued the same conversation" : `a repeated sessionId lost the conversation: ${JSON.stringify(finalText(second).slice(0, 60))}`);
}

/** TRN-3: the harness's native session store lands under HOME where transcript capture reads it. */
export async function checkTranscriptStore(ctx: LiveContext, environment: AgentEnvironment): Promise<void> {
  if (ctx.options.harness !== "claude-code" || typeof environment.exec !== "function") {
    ctx.rec.unproven("TRN-3", "the session store location is probed for claude-code only");
    return;
  }
  const found = await environment.exec('find "$HOME/.claude/projects" -name "*.jsonl" 2>/dev/null | head -3');
  const elsewhere = found.stdout.trim().length > 0 ? undefined : (await environment.exec('find "$HOME" -maxdepth 6 -name "*.jsonl" -not -path "*/node_modules/*" 2>/dev/null | head -2')).stdout.trim();
  ctx.rec.observe("TRN-3", found.stdout.trim().length > 0, found.stdout.trim().length > 0 ? "a native session transcript exists under $HOME/.claude/projects" : `no native session transcript under $HOME/.claude/projects${elsewhere ? `; session files are at ${elsewhere.replace(/\n/g, ", ")}` : ""}`);
}

/** TRN-1 and MAT-8: turn fields the environment cannot honor are refused before any run. */
export async function checkTurnRefusals(ctx: LiveContext, environment: AgentEnvironment): Promise<void> {
  const { rec, capabilities } = ctx;
  const probe = `Reply with exactly ${ctx.nonces.shell}`;
  const cases: { field: string; requirement: "TRN-1" | "MAT-8"; input: Parameters<AgentEnvironment["stream"]>[0]; unless: boolean }[] = [
    { field: "nativeResume", requirement: "TRN-1", input: { prompt: probe, nativeResume: { harness: "claude-code", nativeSessionId: "x", sourceCheckpointId: "y" } }, unless: false },
    { field: "lastEventId", requirement: "TRN-1", input: { prompt: probe, lastEventId: "x" }, unless: capabilities.streaming.replay },
    { field: "detach", requirement: "TRN-1", input: { prompt: probe, detach: true }, unless: capabilities.streaming.detach },
    { field: "interactions", requirement: "TRN-1", input: { prompt: probe, interactions: { kinds: ["permission"] } as never }, unless: capabilities.interactions !== undefined },
    { field: "profile", requirement: "MAT-8", input: { prompt: probe, profile: { ...ctx.profile, tags: ["changed-after-create"] } }, unless: false },
  ];
  for (const entry of cases.filter((candidate) => !candidate.unless)) {
    const turn = await observeTurn(environment, entry.input);
    const refused = turn.error !== undefined && turn.events.length === 0;
    rec.observe(entry.requirement, refused, refused ? `${entry.field} refused before any event: ${errorSummary(turn.error)}` : `${entry.field} was not refused (${turn.events.length} events${turn.error === undefined ? "" : `, error ${errorSummary(turn.error)}`})`);
    if (refused) {
      ctx.refusals.push(turn.error);
      rec.observe("ERR-3", namesField(turn.error, entry.field), `${entry.field}: ${errorSummary(turn.error)}`);
    }
  }
}

/** SEC-1 and SEC-3: the canary set in create input reaches the harness and appears nowhere it must not. */
export async function checkSecrets(ctx: LiveContext, environment: AgentEnvironment, observed: readonly Observed[]): Promise<void> {
  const { rec, nonces, options } = ctx;
  const secrets = [nonces.canary, ...(options.secretValues ?? [])];
  const haystack = JSON.stringify({
    events: observed.flatMap((entry) => entry.turn.events.map((timed) => timed.event)),
    errors: ctx.refusals.map((error) => (error instanceof Error ? error.message : String(error))),
    metadata: environment.metadata ?? {},
  });
  const leaked = secrets.filter((secret) => haystack.includes(secret));
  rec.observe("SEC-3", leaked.length === 0, leaked.length === 0 ? `${secrets.length} secret values are absent from events, errors and metadata` : `a secret value appears in events, errors or metadata`);
  if (typeof environment.exec !== "function") return;
  for (const secret of secrets) {
    const files = await environment.exec(`grep -rlF -e '${secret}' . 2>/dev/null | head -3`);
    rec.observe("SEC-3", files.stdout.trim() === "", files.stdout.trim() === "" ? "no workspace file holds a secret value" : `a workspace file holds a secret value: ${files.stdout.trim().split("\n")[0]}`);
    const argv = await environment.exec(`ps -eo args | grep -F -e '${secret}' | grep -v -e 'grep' -e 'ps -eo' | wc -l`);
    rec.observe("SEC-3", argv.stdout.trim() === "0", argv.stdout.trim() === "0" ? "no process command line holds a secret value" : "a process command line holds a secret value");
  }
  const harnessSees = await environment.exec("printenv CONFORMANCE_CANARY | wc -c");
  rec.observe("SEC-1", Number(harnessSees.stdout.trim()) === nonces.canary.length + 1, "input.env canary reaches the default exec environment exactly");
  if (options.secretValues === undefined || options.secretValues.length === 0) rec.unproven("MOD-3", "no Router key value was supplied, so its absence from argv and files is not probed");
  else rec.observe("MOD-3", leaked.length === 0, "the Router key is absent from events, errors, metadata, files and command lines");
}

/** A sidecar that serves no public revision root refuses profile preparation with this text (Discovery's first-turn 409, 2026-10-31). */
const PREPARATION_REFUSAL = /public profile (?:materialization|preparation) (?:is disabled|failed)/i;

/**
 * MOD-4: a native-credential turn launches, or is refused with a typed error. It never dies on the sidecar's
 * refusal to prepare its profile, which the provider must treat as "launch without preparation".
 */
export async function checkNativeAuthLaunch(ctx: LiveContext, absent: string | undefined): Promise<void> {
  const fixture = ctx.options.nativeAuth;
  if (fixture === undefined) return ctx.rec.unproven("MOD-4", "no nativeAuth fixture supplied, so a native-credential launch is not probed");
  if (absent !== undefined) return ctx.rec.unproven("MOD-4", `no credential: ${absent}`);
  const target = await (fixture.createProvider ?? ctx.options.createProvider)();
  let environment: AgentEnvironment;
  try {
    environment = await ctx.create(fixture.createInput, "native-auth", target);
  } catch (error) {
    const refused = PREPARATION_REFUSAL.test(errorSummary(error));
    ctx.rec.observe("MOD-4", !refused && isEnvironmentProviderError(error), `native-auth create: ${errorSummary(error)}`);
    return;
  }
  const turn = await observeTurn(environment, { prompt: "Reply with exactly OK.", sessionId: `${ctx.runTag}-native-auth`, timeoutMs: TURN_TIMEOUT_MS, ...fixture.turn });
  const text = [turn.error === undefined ? "" : errorSummary(turn.error), ...turn.terminals.map((event) => JSON.stringify(event.data))].join(" ");
  const refused = PREPARATION_REFUSAL.test(text);
  ctx.rec.observe("MOD-4", !refused && turn.events.length > 0, refused ? "the native-credential turn died on the sidecar's refusal to prepare its profile" : turn.events.length > 0 ? `the native-credential turn launched (${turnOutcome(turn)})` : `the native-credential turn produced no event: ${errorSummary(turn.error)}`);
}

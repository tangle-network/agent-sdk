import { randomBytes } from "node:crypto";
import { shellQuote } from "@tangle-network/agent-core/node";
import { EnvironmentProviderError, type ExecRequest, type ExecResult } from "@tangle-network/agent-interface/environment-provider";

/** Exec over a run-to-completion command call: a timeout or abort kills every process carrying the exec's marker, so the remote work stops too. */
export async function markedExec(command: string, options: ExecRequest | undefined, provider: string, run: (script: string, signal: AbortSignal) => Promise<ExecResult>): Promise<ExecResult> {
  options?.signal?.throwIfAborted();
  const marker = randomBytes(6).toString("hex");
  const env = Object.entries(options?.env ?? {}).map(([key, value]) => `export ${key}=${shellQuote(value)}; `).join("");
  const ended = new AbortController();
  const timer = options?.timeoutMs === undefined ? undefined : setTimeout(() => ended.abort(new EnvironmentProviderError("timeout", `exec exceeded ${options.timeoutMs} ms`, { provider })), options.timeoutMs);
  const signal = options?.signal === undefined ? ended.signal : AbortSignal.any([options.signal, ended.signal]);
  try {
    return await run(`export TBOX_EXEC=${marker}; ${env}${options?.cwd === undefined ? "" : `cd ${shellQuote(options.cwd)} && `}${command}`, signal);
  } catch (error) {
    if (signal.aborted) await run(`for p in /proc/[0-9]*; do grep -qz 'TBOX_EXEC=${marker}' "$p/environ" 2>/dev/null && kill -9 "\${p#/proc/}" 2>/dev/null; done; true`, AbortSignal.timeout(30_000)).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** The Bridge's credentials go to a file in a directory only the box user can open, sourced and deleted before exec, so no value enters an argv. */
export function envFileLaunch(command: string, { cwd, env }: { cwd?: string; env: Record<string, string> }) {
  const dir = `/tmp/tbox-${randomBytes(8).toString("hex")}`;
  return {
    prepare: `umask 077 && mkdir ${dir}`,
    file: `${dir}/env`,
    content: Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}\n`).join(""),
    launch: `. ${dir}/env && rm -rf ${dir} && ${cwd === undefined ? "" : `cd ${shellQuote(cwd)} && `}exec ${command} >/tmp/bridge.log 2>&1`,
    cleanup: `rm -rf ${dir}`,
  };
}

/** For an SDK that takes no AbortSignal: an abort settles the call at once, and `late` receives a result that arrives afterwards. */
export async function untilAborted<T>(pending: Promise<T>, signal: AbortSignal | undefined, late?: (value: T) => Promise<unknown>): Promise<T> {
  if (signal === undefined) return pending;
  signal.throwIfAborted();
  let onAbort = (): void => undefined;
  const aborted = new Promise<never>((_, reject) => signal.addEventListener("abort", (onAbort = () => reject(signal.reason)), { once: true }));
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (signal.aborted && late !== undefined) void pending.then(late).catch(() => undefined);
  }
}

/** The pids alive in the sandbox, one per line: the baseline a turn's processes are measured against. */
export function pidListScript(): string {
  return "for d in /proc/[0-9]*; do echo ${d#/proc/}; done";
}

/**
 * A harness may put tool children outside its process group (opencode's Bash tool spawns them detached), where
 * neither the harness's exit nor the adapter's group kill reaches them. After every turn the box restores the
 * process set it had before the turn: one pass over /proc/*/status (cat skips the already-dead) TERMs, then
 * KILLs, every pid outside the baseline that is not the sweep shell's own tree — the baseline already covers
 * everything older than the turn, including pid 1, so orphans reparented to pid 1 are still caught.
 */
export function turnSweepScript(baseline: readonly string[]): string {
  return [
    `victims=$(cat /proc/[0-9]*/status 2>/dev/null | awk -v base=${shellQuote(` ${baseline.join(" ")} `)} -v self=$$ '`,
    `$1 == "Pid:" { p = $2 } $1 == "PPid:" { ppid[p] = $2 }`,
    `END {`,
    `  split(base, b, / +/); for (i in b) if (b[i] != "") known[b[i]] = 1`,
    `  mine[self] = 1; changed = 1`,
    `  while (changed) { changed = 0; for (p in ppid) if (!(p in mine) && (ppid[p] in mine)) { mine[p] = 1; changed = 1 } }`,
    `  for (p in ppid) if (!(p in known) && !(p in mine)) printf "%s ", p`,
    `}')`,
    `[ -z "$victims" ] && exit 0; kill -TERM $victims 2>/dev/null; sleep 1; kill -KILL $victims 2>/dev/null; true`,
  ].join("\n");
}

import { NATIVE_SESSION_CONTRACTS } from "@tangle-network/cli-agent-registry/native-session-contracts";
import { materializeProfile } from "@tangle-network/agent-profile-materialize";
import type { AgentEnvironment } from "@tangle-network/agent-interface/environment-provider";
import { errorSummary, listRun, until, versionBinary, type LiveContext } from "./context.js";
import { checkExposure } from "./checks-capability.js";
import { describeError } from "./turns.js";

/** P1: CRT-1, CRT-3, CRT-7, CRT-8, MAT-2, SEC-1. */
export async function checkBoot(ctx: LiveContext, environment: AgentEnvironment): Promise<void> {
  const { rec, options } = ctx;
  checkExposure(ctx, environment);
  const status = await environment.status();
  rec.observe("CRT-1", status === "running", `status() right after create is ${status}`);
  rec.observe("CRT-7", status === "running", `status() reports ${status} for a live environment`);
  rec.observe("CRT-3", environment.creation !== "replayed", `creation is ${environment.creation ?? "absent (unprovable)"}`);
  const placement = typeof environment.placement === "function" ? await environment.placement() : undefined;
  const placed = placement !== undefined && placement.kind !== "local" && typeof placement.sandboxId === "string" && placement.sandboxId.length > 0;
  rec.observe("CRT-8", placed, placement === undefined ? "no placement()" : `placement kind ${placement.kind}, sandboxId ${placement.sandboxId ?? "absent"}`);
  const binary = versionBinary(options);
  const pin = (NATIVE_SESSION_CONTRACTS as Record<string, { cliVersion?: string } | undefined>)[options.harness]?.cliVersion;
  if (binary === undefined || pin === undefined || typeof environment.exec !== "function") {
    rec.unproven("MAT-2", "no version command or pin for this harness");
  } else {
    const probe = await environment.exec(`${binary} --version`, { timeoutMs: 60_000 });
    const printed = probe.stdout.trim().split(/\s+/)[0];
    rec.observe("MAT-2", probe.exitCode === 0 && printed === pin, `${binary} --version printed "${probe.stdout.trim() || probe.stderr.trim()}" (exit ${probe.exitCode}); the registry pins ${pin}`);
  }
}

/** WSP-1 and SEC-1 against the main environment. */
export async function checkWorkspaceIo(ctx: LiveContext, environment: AgentEnvironment): Promise<void> {
  const { rec, nonces } = ctx;
  if (typeof environment.write !== "function" || typeof environment.read !== "function" || typeof environment.exec !== "function") {
    rec.fail("WSP-1", "environment lacks read, write or exec");
    return;
  }
  const content = `line one\nnon-ascii: café ✓\n${nonces.shell}\n\ttabbed\n`;
  await environment.write("conformance/nested/probe.txt", content);
  const readBack = await environment.read("conformance/nested/probe.txt");
  rec.observe("WSP-1", readBack === content, readBack === content ? "read returns exactly the bytes write stored, parents created" : "read differs from what write stored");
  const viaExec = await environment.exec("cat conformance/nested/probe.txt");
  rec.observe("WSP-1", viaExec.stdout === content, viaExec.stdout === content ? "a relative write path resolves against the exec cwd" : `a relative write path does not resolve against the exec cwd: ${JSON.stringify(viaExec.stderr.trim().slice(0, 120))}`);
  const split = await environment.exec("echo out-line; echo err-line 1>&2; exit 3");
  rec.observe("WSP-1", split.exitCode === 3 && split.stdout === "out-line\n" && split.stderr === "err-line\n", `exec returned exit ${split.exitCode}, stdout ${JSON.stringify(split.stdout)}, stderr ${JSON.stringify(split.stderr)} for a non-zero exit`);
  const cwdEnv = await environment.exec("pwd; printenv CONFORMANCE_OPTION", { cwd: "conformance/nested", env: { CONFORMANCE_OPTION: "opt-value" } });
  const [where, option] = cwdEnv.stdout.split("\n");
  rec.observe("WSP-1", where?.endsWith("/conformance/nested") === true && option === "opt-value", `exec honors cwd and env options: ${JSON.stringify(cwdEnv.stdout)}${cwdEnv.stderr ? ` ${cwdEnv.stderr.trim().slice(0, 120)}` : ""}`);
  const plain = await environment.exec("printenv CONFORMANCE_PLAIN");
  rec.observe("SEC-1", plain.stdout.trim() === "plain-value", `input.env reaches the default exec environment: ${JSON.stringify(plain.stdout.trim())}`);
}

/** WSP-2 and WSP-3 with a created-from-repository environment. */
export async function checkRepository(ctx: LiveContext, repo: NonNullable<LiveContext["options"]["repository"]>): Promise<void> {
  const { rec } = ctx;
  let environment: AgentEnvironment | undefined;
  try {
    environment = await ctx.create({ workspace: { repoUrl: repo.url, gitRef: repo.ref, cwd: { base: "repository", path: repo.cwd } } }, "repository");
    if (typeof environment.exec !== "function" || typeof environment.read !== "function") {
      rec.fail("WSP-3", "environment lacks exec or read");
      return;
    }
    const where = await environment.exec("pwd");
    rec.observe("WSP-2", where.stdout.trim().endsWith(repo.cwd), `exec cwd is ${where.stdout.trim()} for repository cwd ${repo.cwd}`);
    const file = await environment.read(repo.file).then((text) => text.length > 0, () => false);
    rec.observe("WSP-2", file, `a relative read resolves against the repository cwd (${repo.file})`);
    const head = await environment.exec("git rev-parse HEAD");
    rec.observe("WSP-3", head.stdout.trim() === repo.ref, `checked out ${head.stdout.trim().slice(0, 12)} for ${repo.ref.slice(0, 12)}`);
  } catch (error) {
    rec.fail("WSP-3", `create from a repository failed: ${errorSummary(error)}`);
  }
}

/** P2: MAT-3, MAT-5, MAT-6 and the file half of MAT-7, against the plan the shared materializer computes. */
export async function checkPlanBytes(ctx: LiveContext, environment: AgentEnvironment): Promise<void> {
  const { rec, options } = ctx;
  if (typeof environment.read !== "function" || typeof environment.exec !== "function") return;
  let plan: ReturnType<typeof materializeProfile>;
  try {
    plan = materializeProfile(ctx.profile, options.harness as Parameters<typeof materializeProfile>[1]);
  } catch (error) {
    rec.fail("MAT-3", `the shared materializer rejects the probe profile: ${describeError(error)}`);
    return;
  }
  rec.pass("MAT-3", `the shared materializer plans ${plan.files.length} files for ${options.harness}`);
  const home = (await environment.exec('printf %s "$HOME"')).stdout.trim();
  const readText = async (path: string): Promise<string | undefined> => {
    const result = await environment.exec!(`cat -- '${path}'`).catch(() => undefined);
    return result?.exitCode === 0 ? result.stdout : undefined;
  };
  const missing: string[] = [];
  const notes: string[] = [];
  for (const file of plan.files) {
    const path = String((file as { relPath?: string }).relPath ?? "");
    const root = (file as { root?: string }).root ?? "workspace";
    const expected = String((file as { content?: unknown }).content ?? "");
    if ((await readText(root === "agent" ? `${home}/${path}` : path)) === expected) continue;
    const generated = (file as { source?: string }).source === "generated";
    if (generated) {
      const candidates = (await environment.exec("find .tangle .claude -type f 2>/dev/null")).stdout.split("\n").filter(Boolean);
      const moved = await Promise.all(candidates.map(readText));
      if (moved.includes(expected)) {
        notes.push(`${path} relocated by the adapter`);
        continue;
      }
      if (/mcp/i.test(path) && ctx.axes.mcp === true) {
        notes.push(`${path} delivered ephemerally and proven by the MCP call`);
        continue;
      }
    }
    const base = path.split("/").at(-1) ?? path;
    const elsewhere = (await environment.exec(`find "$HOME" -maxdepth 4 -name '${base}' -not -path '*/node_modules/*' 2>/dev/null | head -1`)).stdout.trim();
    missing.push(`${root}:${path}${elsewhere ? ` (found at ${elsewhere})` : ""}`);
  }
  rec.observe("MAT-5", missing.length === 0, missing.length === 0 ? `all ${plan.files.length} plan files present with exact bytes${notes.length > 0 ? ` (${notes.join("; ")})` : ""}` : `plan files absent or different from the exec cwd: ${missing.join(", ")}`);
  rec.observe("MAT-7", missing.length === 0, `plan files ${missing.length === 0 ? "match" : "differ"} (resources.files, tools, instructions)`);
  const executable = ctx.profile.resources?.files?.filter((file) => file.executable === true) ?? [];
  for (const file of executable) {
    const mode = await environment.exec(`test -x '${file.path}'`);
    rec.observe("MAT-7", mode.exitCode === 0, `${file.path} is executable`);
  }
  const requires = plan.requires ?? [];
  if (requires.length === 0) rec.pass("MAT-6", "the plan requires no harness extension");
  else rec.unproven("MAT-6", `plan requires ${requires.map((entry) => entry.id).join(", ")}; presence is not probed`);
  const unsupported = plan.unsupported ?? [];
  if (unsupported.length > 0) rec.observe("MAT-4", false, `the probe profile plans unsupported entries (${unsupported.map((entry) => entry.dimension).join(", ")}) yet create accepted it`);
}

/** TDN-1, TDN-2, TDN-5, CRT-5, CRT-6, CRT-7 for the main environment, then leak sweep. */
export async function checkTeardown(ctx: LiveContext, environment: AgentEnvironment): Promise<void> {
  const { rec, provider } = ctx;
  const before = await listRun(ctx);
  if (before === undefined) {
    rec.unproven("CRT-6", "the provider has no list");
    rec.unproven("TDN-5", "the provider has no list");
  } else {
    const entry = before.find((candidate) => candidate.id === environment.id);
    rec.observe("CRT-6", entry !== undefined && entry.status === "running", entry === undefined ? "list({metadata}) does not find the live environment" : `list reports status ${entry.status}`);
    rec.observe("TDN-5", entry !== undefined, "list({metadata}) finds the run's environment");
  }
  if (typeof provider.get === "function") {
    const found = await provider.get(environment.id).then((value) => ({ value }), (error: unknown) => ({ error }));
    const foundId = "value" in found ? found.value?.id : undefined;
    rec.observe("CRT-5", foundId === environment.id, "error" in found ? `get(id) threw ${errorSummary(found.error)}` : `get(id) returns ${foundId ?? "null"}`);
    const absent = await provider.get(`${environment.id}-absent`).catch((error: unknown) => error);
    rec.observe("CRT-5", absent === null, absent === null ? "get of an unknown id returns null" : `get of an unknown id: ${absent instanceof Error ? errorSummary(absent) : "returned an environment"}`);
    if (ctx.capabilities.create?.proxySecrets === undefined) {
      const refused = await provider.get(environment.id, { proxySecrets: [] }).then(() => false, () => true);
      rec.observe("CRT-5", refused, refused ? "get refuses the proxySecrets option it does not honor" : "get accepted proxySecrets it does not honor");
    }
  }
  await environment.destroy?.();
  const second = await environment.destroy?.().then(() => true, () => false);
  rec.observe("TDN-2", second !== false, second === false ? "the second destroy rejected" : "the second destroy resolved");
  const status = await environment.status().catch((error: unknown) => `threw ${describeError(error)}`);
  rec.observe("CRT-7", status === "stopped" || status === "expired", `status() after destroy is ${status}`);
  if (typeof provider.get === "function") {
    const gone = await until(async () => (await provider.get!(environment.id)) === null, 60_000);
    rec.observe("TDN-1", gone, gone ? "get(id) is null after destroy" : "get(id) still returns the environment 60 s after destroy");
  }
  const after = await listRun(ctx);
  if (after !== undefined) {
    const survivor = await until(async () => !(await listRun(ctx))!.some((entry) => entry.id === environment.id), 60_000);
    rec.observe("TDN-1", survivor, survivor ? "the vendor list no longer shows the environment" : "the vendor list still shows the environment after destroy");
    void after;
  }
}

/** After every probe: nothing tagged with this run survives. Destroys and reports survivors. */
export async function sweepLeaks(ctx: LiveContext): Promise<void> {
  if (typeof ctx.provider.list !== "function") {
    ctx.rec.unproven("TDN-3", "the provider has no list, so leaks cannot be read from the vendor side");
    return;
  }
  await until(async () => (await listRun(ctx))!.every((entry) => entry.status === "stopped" || entry.status === "expired"), 90_000, 3_000);
  const survivors = (await listRun(ctx))!.filter((entry) => entry.status !== "stopped" && entry.status !== "expired");
  const aborted = survivors.filter((entry) => entry.case?.includes("abort-create"));
  const others = survivors.filter((entry) => !entry.case?.includes("abort-create"));
  const name = (entry: { id: string; case?: string }): string => `${entry.id} (${entry.case ?? "untagged case"})`;
  ctx.rec.observe("TDN-3", others.length === 0, others.length === 0 ? "no environment tagged with this run survives" : `survivors after cleanup: ${others.map(name).join(", ")}`);
  ctx.rec.observe("CAN-3", aborted.length === 0, aborted.length === 0 ? "no sandbox survives a create aborted mid-flight" : `a create aborted mid-flight left a sandbox: ${aborted.map(name).join(", ")}`);
  ctx.rec.observe("CRT-2", others.length === 0, others.length === 0 ? "no refused request provisioned an environment" : "a refused or failed request left an environment");
  for (const entry of survivors) {
    const environment = await ctx.provider.get?.(entry.id).catch(() => null);
    await environment?.destroy?.().catch(() => undefined);
  }
}

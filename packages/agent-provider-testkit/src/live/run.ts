import type {
  AgentEnvironment,
  AgentEnvironmentProvider,
  CreateAgentEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";
import { checkCreateRefusals, checkProviderDocument, isTyped } from "./checks-capability.js";
import { checkAbort, checkBusyEnvironment, checkConcurrency, checkCreateFailures, checkDestroyMidTurn, checkExecCancel, checkTimeout } from "./checks-control.js";
import { checkBoot, checkPlanBytes, checkRepository, checkTeardown, checkWorkspaceIo, sweepLeaks } from "./checks-environment.js";
import { checkAxes, checkContinuation, checkNativeAuthLaunch, checkSecrets, checkTranscriptStore, checkTurnRefusals } from "./checks-turns.js";
import { DEFAULT_REPOSITORY, newRunTag, RUN_TAG_KEY, type LiveContext, type LiveProfileConformanceOptions } from "./context.js";
import { freshNonces, probeProfile } from "./probe-profile.js";
import { Recorder, summarize, type LiveConformanceReport, type RequirementId } from "./report.js";
import { describeError } from "./turns.js";

/** The first credential name the environment lacks, or undefined when every one is set. */
export function missingCredential(options: Pick<LiveProfileConformanceOptions, "credentials" | "env">): string | undefined {
  const env = options.env ?? process.env;
  return options.credentials.find((name) => (env[name] ?? "").trim() === "");
}

const UNPROVEN_AT_THIS_SEAM: ReadonlyArray<readonly [RequirementId, string]> = [
  ["CAP-3", "needs the same provider on two backends; one deployment was exercised"],
  ["MOD-5", "needs an over-cap Router key to force an upstream capacity failure; none was supplied"],
  ["TDN-4", "the vendor sandbox lifetime and run tag are read from the vendor account, not through the provider seam"],
  ["WSP-7", "needs agent-runtime's workspaceRetention port (P11)"],
];

/**
 * Run the live profile-execution conformance suite (SPEC.md section 4) against
 * a real provider with a real profile. A missing credential skips the whole run
 * with an explicit `no credential: <NAME>` result; it never reports a pass.
 */
export async function runLiveProfileConformance(options: LiveProfileConformanceOptions): Promise<LiveConformanceReport> {
  const startedAt = new Date().toISOString();
  const runTag = newRunTag();
  const rec = new Recorder();
  const absent = missingCredential(options);
  const base = { provider: options.name, runTag, harness: options.harness, model: options.model, startedAt };
  if (absent !== undefined) {
    const results = rec.results(`no credential: ${absent}`);
    return { ...base, finishedAt: new Date().toISOString(), skipped: `no credential: ${absent}`, counts: summarize(results), results, stageErrors: [] };
  }
  const log = options.log ?? (() => undefined);
  const provider: AgentEnvironmentProvider = await options.createProvider();
  const nonces = freshNonces();
  const profile = probeProfile(options.harness, options.model, nonces, runTag);
  const environments: AgentEnvironment[] = [];
  const refusals: unknown[] = [];
  const stageErrors: string[] = [];
  const ctx: LiveContext = {
    options, rec, provider, nonces, profile, runTag, refusals, environments, log, axes: {},
    capabilities: await provider.capabilities(),
    async create(overrides = {}, caseName = "main", target = provider) {
      const input: CreateAgentEnvironmentInput = {
        profile,
        env: { CONFORMANCE_PLAIN: "plain-value", CONFORMANCE_CANARY: nonces.canary },
        name: `${runTag}-${caseName}`,
        ...(options.createInput ?? {}),
        ...overrides,
        metadata: { [RUN_TAG_KEY]: runTag, "conformance-case": caseName, ...((overrides.metadata as Record<string, unknown> | undefined) ?? {}) },
      };
      const environment = await target.create(input);
      environments.push(environment);
      return environment;
    },
    async expectRefusal(overrides, caseName) {
      try {
        const environment = await ctx.create(overrides, caseName);
        return { refused: false, environment };
      } catch (error) {
        return { refused: true, error };
      }
    },
  };
  const stage = async (name: string, work: () => Promise<unknown>): Promise<void> => {
    log(`stage ${name}`);
    try {
      await work();
    } catch (error) {
      log(`stage ${name} threw: ${describeError(error)}`);
      stageErrors.push(`${name}: ${describeError(error)}`);
    }
  };
  try {
    await stage("document", () => checkProviderDocument(ctx));
    let main: AgentEnvironment | undefined;
    await stage("create", async () => {
      main = await ctx.create();
    });
    if (main === undefined) {
      rec.fail("CRT-1", "create with the probe profile failed, so no environment-level probe could run");
    } else {
      const environment = main;
      const observed = await (async () => {
        await stage("boot", () => checkBoot(ctx, environment));
        await stage("workspace", () => checkWorkspaceIo(ctx, environment));
        let axes: Awaited<ReturnType<typeof checkAxes>> = [];
        await stage("axes", async () => {
          axes = await checkAxes(ctx, environment);
        });
        await stage("plan bytes", () => checkPlanBytes(ctx, environment));
        await stage("transcript", () => checkTranscriptStore(ctx, environment));
        await stage("continuation", () => checkContinuation(ctx, environment));
        await stage("turn refusals", () => checkTurnRefusals(ctx, environment));
        await stage("exec cancel", () => checkExecCancel(ctx, environment));
        await stage("abort", () => checkAbort(ctx, environment));
        await stage("timeout", () => checkTimeout(ctx, environment));
        await stage("busy", () => checkBusyEnvironment(ctx, environment));
        return axes;
      })();
      await stage("secrets", () => checkSecrets(ctx, environment, observed));
      await stage("teardown", () => checkTeardown(ctx, environment));
    }
    await stage("refusals", () => checkCreateRefusals(ctx));
    await stage("repository", () => checkRepository(ctx, options.repository ?? DEFAULT_REPOSITORY));
    await stage("native auth", () => checkNativeAuthLaunch(ctx, missingCredential({ credentials: options.nativeAuth?.credentials ?? [], env: options.env })));
    await stage("create failures", () => checkCreateFailures(ctx));
    await stage("destroy mid-turn", () => checkDestroyMidTurn(ctx));
    await stage("concurrency", () => checkConcurrency(ctx));
  } finally {
    await Promise.allSettled(environments.map((environment) => environment.destroy?.()));
    await stage("leak sweep", () => sweepLeaks(ctx));
  }
  isTyped(ctx);
  for (const [id, reason] of UNPROVEN_AT_THIS_SEAM) rec.unproven(id, reason);
  const claimed = Object.entries({
    retainedControl: ctx.capabilities.retainedControl, nativeContinuation: ctx.capabilities.nativeContinuation, contextTransfer: ctx.capabilities.contextTransfer,
    interactions: ctx.capabilities.interactions, branching: ctx.capabilities.branching.checkpoint || ctx.capabilities.branching.fork ? true : undefined,
    exactProcess: ctx.capabilities.exactProcess, interactiveTerminal: ctx.capabilities.interactiveTerminal, interactiveAgent: ctx.capabilities.interactiveAgent,
  }).filter(([, value]) => value !== undefined).map(([key]) => key);
  if (claimed.length === 0) rec.pass("OPT-1", "no optional tier is claimed");
  else rec.unproven("OPT-1", `claims ${claimed.join(", ")}; the matching testkit suites are not part of this run`);
  const branching = ctx.capabilities.branching.checkpoint || ctx.capabilities.branching.fork;
  if (!branching) rec.pass("WSP-8", "checkpoint and fork are not claimed");
  const results = rec.results();
  return { ...base, finishedAt: new Date().toISOString(), counts: summarize(results), results, stageErrors };
}

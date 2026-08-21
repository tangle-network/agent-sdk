import type { ExecResult } from "./environment-requests.js";
import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
  AgentEnvironmentEvent,
  AgentTurnInput,
} from "./environment-runtime.js";

/**
 * Read one non-empty string from an untyped provider-options bag.
 *
 * An absent key and a present key holding a non-string or an empty string are
 * the same answer: the caller named nothing.
 */
function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Normalize the untyped return of a sandbox SDK's command call into
 * {@link ExecResult}.
 *
 * Sandbox SDKs name the same three facts differently: an exit status under
 * `exitCode` or `code`, captured output under `stdout` or `output`, and
 * captured errors under `stderr` or `error`. Reading both names in one place
 * keeps every adapter's exec surface answering with the same shape.
 */
export function execResultFromUnknown(value: unknown): ExecResult {
  const record =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    exitCode: number(record.exitCode) ?? number(record.code) ?? 0,
    stdout:
      typeof record.stdout === "string"
        ? record.stdout
        : typeof record.output === "string"
          ? record.output
          : "",
    stderr:
      typeof record.stderr === "string"
        ? record.stderr
        : typeof record.error === "string"
          ? record.error
          : "",
  };
}

export interface CommandTurnOptions {
  /** The turn the caller asked this environment to run. */
  input: AgentTurnInput;
  /** The environment whose `exec` runs the command. */
  environment: AgentEnvironment;
  /** The adapter name the refusal names when no command can be resolved. */
  providerLabel: string;
  /** The caller's explicit command for this turn, chosen before any default. */
  turnCommand?: (
    input: AgentTurnInput,
    environment: AgentEnvironment,
  ) => string | Promise<string>;
}

/**
 * Run one turn as a single command in an environment whose only surface is a
 * workspace, and emit the turn's events.
 *
 * The command comes from the caller's `turnCommand`, then
 * `providerOptions.command` or `providerOptions.agentCommand`, then the
 * prompt. An environment that reaches none of them cannot run the turn and
 * the turn is refused rather than executing an empty command.
 */
export async function* commandTurnEvents(
  options: CommandTurnOptions,
): AsyncIterable<AgentEnvironmentEvent> {
  const { input, environment, providerLabel } = options;
  const command =
    (await options.turnCommand?.(input, environment)) ??
    stringOption(input.providerOptions?.command) ??
    stringOption(input.providerOptions?.agentCommand) ??
    input.prompt;
  if (!command) {
    throw new Error(
      `${providerLabel} provider requires turnCommand, providerOptions.command, or prompt`,
    );
  }
  const result = await environment.exec?.(command, {
    cwd: stringOption(input.providerOptions?.cwd),
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  const text = result?.stdout ?? "";
  yield { type: "message.part.updated", data: { delta: text } };
  yield {
    type: "result",
    data: {
      finalText: text,
      status: result?.exitCode === 0 ? "completed" : "failed",
      exitCode: result?.exitCode ?? 1,
      stderr: result?.stderr ?? "",
    },
  };
}

/**
 * The capability document of a provider whose only surface is a workspace.
 *
 * Such an adapter runs commands and moves files in a sandbox. It owns no
 * agent profile, serves no live or replayable stream, keeps no provider
 * session, and branches no environment, so every surface outside `workspace`
 * and `placement` reads false. The caller states its own workspace facts
 * because they are the only ones that differ between these adapters.
 */
export function execOnlyEnvironmentCapabilities(
  workspace: AgentEnvironmentCapabilities["workspace"],
): AgentEnvironmentCapabilities {
  return {
    profile: {
      namedProfiles: false,
      systemPrompt: { replace: false, append: false },
      instructions: false,
      tools: false,
      permissions: false,
      mcp: false,
      subagents: false,
      resources: {
        files: true,
        instructions: false,
        tools: false,
        skills: false,
        agents: false,
        commands: false,
      },
      hooks: false,
      modes: false,
      runtimeUpdate: false,
      validation: false,
    },
    streaming: {
      live: false,
      replay: false,
      detach: false,
      turnIdempotency: false,
    },
    sessions: { continue: false, list: false, messages: false },
    workspace: { ...workspace },
    branching: { checkpoint: false, fork: false },
    placement: true,
    usage: false,
    confidential: false,
  };
}

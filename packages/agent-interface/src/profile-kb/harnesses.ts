import type { ProfileKbHarness, ProfileKbSource } from "./types.js";
import { claim, kbEntry } from "./entry.js";

const CHECKED = "2026-10-04";
const source = (url: string, locator: string): ProfileKbSource => ({
  url,
  locator,
  checkedAt: CHECKED,
  authority: "primary",
});
const claudeCli = source(
  "https://code.claude.com/docs/en/cli-reference",
  "CLI flags: --print, --bg, --bare, system prompt flags",
);
const claudeAgents = source(
  "https://code.claude.com/docs/en/sub-agents",
  "How subagents work; forked subagents",
);
const codexConfig = source(
  "https://learn.chatgpt.com/docs/config-file/config-reference",
  "model_instructions_file; model_reasoning_effort",
);
const codexAgents = source(
  "https://learn.chatgpt.com/docs/agent-configuration/subagents",
  "Availability; approvals and sandbox controls",
);
const codexCommands = source(
  "https://learn.chatgpt.com/docs/developer-commands",
  "Set or view a task goal with /goal",
);
const piBase =
  "https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/";
const piCli = source(
  `${piBase}docs/cli.md`,
  "Invocation and output; models; prompts and process",
);
const piRpc = source(`${piBase}docs/rpc.md#run-lifecycle`, "Run lifecycle");
const piCommands = source(
  `${piBase}docs/rpc-commands.md`,
  "steer; follow_up; get_available_thinking_levels",
);
const opencodeCli = source("https://opencode.ai/docs/cli/", "run; serve; acp");
const opencodePrompt = source(
  "https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/llm/request.ts#L51-L70",
  "LLMRequestPrep.prepare",
);
const kimiCli = source(
  "https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html",
  "Flag conflict rules; non-interactive execution",
);
const kimiConfig = source(
  "https://moonshotai.github.io/kimi-code/en/configuration/config-files.html",
  "Config file location; thinking; complete example",
);

/** Source-qualified launch knowledge; versions describe checked sources, not every host's installation. */
export const profileKbHarnesses: readonly ProfileKbHarness[] = [
  kbEntry({
    id: "claude-code",
    name: "Claude Code",
    version: "2.1.289",
    claims: [
      claim(
        "For a non-forked subagent, supply the context needed for its task; forked subagents inherit the parent conversation.",
        claudeAgents,
        "documented",
        "agent",
      ),
      claim(
        "Headless: claude -p <prompt> --model <id> --effort <level> --output-format stream-json --verbose. --bg is a separate background-session mode and cannot combine with -p.",
        claudeCli,
      ),
      claim(
        "--append-system-prompt adds to the default; --system-prompt replaces it. On resume, prompt changes may wait for compaction.",
        claudeCli,
      ),
      claim(
        "--bare skips automatic discovery; explicitly supplied context can still load. It is not an established speed improvement for this workload.",
        claudeCli,
      ),
      claim(
        "--max-budget-usd caps the print invocation's spend, excluding restored prior spend; --json-schema constrains output structure, not correctness.",
        claudeCli,
      ),
    ],
  }),
  kbEntry({
    id: "codex",
    name: "Codex CLI",
    version: "0.160.0",
    claims: [
      claim(
        "Observed on the Mac: codex exec <prompt> -m <model> -c model_reasoning_effort=<level> --json -o <file>; --output-schema, review, resume and fork are available.",
        {
          url: "cli:codex --version; codex exec --help",
          checkedAt: CHECKED,
          authority: "local",
          locator:
            "Codex 0.160.0, Mac; research/anthropic-openai.md#local-codex-catalog-evidence",
        },
        "local-observation",
      ),
      claim(
        "model_instructions_file replaces model instructions. Reasoning support is model/client-specific; a requested effort does not establish the effective effort.",
        codexConfig,
      ),
      claim(
        "Current local Codex spawns subagents after a direct request or applicable project/skill instruction. Enabled features do not establish tool exposure in another integration.",
        codexAgents,
      ),
      claim(
        "/goal tracks an interactive objective; it does not establish recovery across host or process restarts.",
        codexCommands,
      ),
    ],
  }),
  kbEntry({
    id: "opencode",
    name: "OpenCode",
    version: "1.18.34",
    claims: [
      claim(
        "Headless: opencode run <message> -m <provider/model> --agent <name> --variant <variant> --format json. Variants are provider-specific.",
        opencodeCli,
      ),
      claim(
        "A configured agent.prompt replaces the provider prompt before system/user additions; plugins can transform it further. Do not assume the provider prompt is retained.",
        opencodePrompt,
      ),
      claim(
        "serve exposes an HTTP API, run --attach reuses that server, and acp exposes an IDE protocol; these capabilities do not establish a particular parent adapter's support.",
        opencodeCli,
      ),
    ],
  }),
  kbEntry({
    id: "pi",
    name: "Pi",
    version: "1.0.2",
    claims: [
      claim(
        "Headless: pi -p <prompt> --model <provider/id[:thinking]> --mode json. Model arguments can fuzzy-match; inspect the selected identity. --thinking clamps to model capability.",
        piCli,
      ),
      claim(
        "--system-prompt replaces the default; --append-system-prompt adds to it. JSON mode exits after supplied prompts; RPC stays alive on stdin/stdout.",
        piCli,
      ),
      claim(
        "In Pi 1.0.2 RPC, prompt acceptance and agent_end do not prove settlement: wait for agent_settled, except a handled prompt that began no run.",
        piRpc,
      ),
      claim(
        "RPC steering arrives after current tool calls, before the next model call; follow-ups wait for tool calls and steering to drain. Query get_available_thinking_levels for the selected model.",
        piCommands,
      ),
    ],
  }),
  kbEntry({
    id: "kimi-code",
    name: "Kimi Code CLI",
    version: "2.1.1",
    claims: [
      claim(
        "Headless: kimi -p <prompt> -m <configured-alias> --output-format stream-json. Print mode already uses auto policy with static deny rules; it rejects --auto, --yolo and --plan.",
        kimiCli,
      ),
      claim(
        "--agent-file selects a new session's custom agent and cannot combine with resume/continue.",
        kimiCli,
      ),
      claim(
        "kimi-code/k3 is a configured coding-provider alias, not Moonshot's public API ID kimi-k3. Configuration lives under KIMI_CODE_HOME or ~/.kimi-code.",
        kimiConfig,
      ),
      claim(
        "[thinking].effort is model-dependent; unsupported settings fall back to the model default. The documented K3 configuration supports low, high and max.",
        kimiConfig,
      ),
    ],
  }),
];

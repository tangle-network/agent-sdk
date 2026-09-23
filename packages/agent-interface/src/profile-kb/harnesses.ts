import type { ProfileKbHarness } from "./types.js";

const CHECKED = "2026-09-22";

/**
 * The frontier coding harnesses this platform runs, checked against the
 * installed CLI on 2026-09-22.
 *
 * `prompt` lines go into the agent's prompt; `operator` lines are launch
 * facts. Each harness is described on its own terms.
 */
export const profileKbHarnesses: readonly ProfileKbHarness[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    version: "2.1.280",
    sources: [
      {
        url: "https://code.claude.com/docs/en/cli-reference",
        checkedAt: CHECKED,
      },
      { url: "cli:claude --help", checkedAt: CHECKED, note: "2.1.280" },
    ],
    prompt: [
      "Delegate independent slices to subagents, several in one turn so they run in parallel, then synthesize their results.",
      "Use the skills listed in your session for procedures they cover.",
      "Run long commands in the background and keep working while they finish.",
    ],
    operator: [
      "Headless: `claude -p <prompt> --model <id> --effort <level> --output-format stream-json`.",
      "`--append-system-prompt` adds to the built-in prompt; `--system-prompt` replaces it.",
      "`--max-budget-usd` caps spend; `--json-schema` validates structured output; `--mcp-config` loads MCP servers.",
      "`--bg` starts a background session; `--bare` skips hooks, plugins, memory, and CLAUDE.md discovery.",
    ],
  },
  {
    id: "codex",
    name: "Codex CLI",
    version: "0.152.1",
    sources: [
      { url: "https://learn.chatgpt.com/docs/models", checkedAt: CHECKED },
      {
        url: "cli:codex exec --help; codex features list",
        checkedAt: CHECKED,
        note: "0.152.1; multi_agent stable and enabled",
      },
    ],
    prompt: [
      "Split independent work across child agents with spawn_agent, and join them with wait_agent.",
      "Edit with apply_patch and search with rg.",
      "Carry the task end to end in this turn: gather context, implement, run the checks, and report the evidence.",
    ],
    operator: [
      "Headless: `codex exec <prompt> -m <model> -c model_reasoning_effort=<level> --json -o <last-message-file>`.",
      "`--output-schema <file>` enforces structured output. `codex review` runs a non-interactive review.",
      "Reasoning levels are per model; read them from `$CODEX_HOME/models_cache.json`.",
      "System-prompt replacement uses the `model_instructions_file` config key; standing instructions go in AGENTS.md.",
      "`/goal` runs long unattended work; `resume` and `fork` continue a session.",
    ],
  },
  {
    id: "opencode",
    name: "OpenCode",
    version: "1.18.18",
    sources: [
      { url: "https://opencode.ai/docs/cli/", checkedAt: CHECKED },
      { url: "cli:opencode run --help", checkedAt: CHECKED, note: "1.18.18" },
    ],
    prompt: [
      "Delegate a focused subtask to a named agent when its persona or model fits the subtask.",
      "Use the mounted MCP tools for external actions.",
    ],
    operator: [
      "Headless: `opencode run <message> -m <provider/model> --agent <name> --variant <effort> --format json`.",
      "Standing text goes through `instructions` files or appended system text; the built-in prompt stays in place.",
      "`opencode serve` with `run --attach <url>`, or `opencode acp`, gives a parent live control.",
    ],
  },
  {
    id: "pi",
    name: "Pi",
    version: "0.83.0",
    sources: [
      { url: "cli:pi --help", checkedAt: CHECKED, note: "0.83.0" },
    ],
    prompt: [
      "Expect steering messages mid-run and fold each one into the current plan.",
      "Fan out independent work by running `pi -p <task> --mode json` from bash, several at once, and read the results back.",
    ],
    operator: [
      "Headless: `pi -p <prompt> --model <provider/id[:thinking]> --mode json`.",
      "`--mode rpc` takes JSONL commands on stdin (steer, follow-up, set model, compact, fork) for live control.",
      "`--thinking` takes off, minimal, low, medium, high, xhigh, or max.",
      "`--system-prompt` replaces the default; `--append-system-prompt` adds to it.",
    ],
  },
  {
    id: "kimi-code",
    name: "Kimi Code CLI",
    version: "0.36.1",
    sources: [
      { url: "https://moonshotai.github.io/kimi-code/", checkedAt: CHECKED },
      {
        url: "cli:kimi --help; ~/.kimi-code/config.toml",
        checkedAt: CHECKED,
        note: "0.36.1",
      },
    ],
    prompt: [
      "Plan the change first, then edit and verify each step against tests and runtime output.",
    ],
    operator: [
      "Headless: `kimi -p <prompt> -m kimi-code/k3 --output-format stream-json`.",
      "`--auto` runs fully autonomous; `--agent-file <path>` loads an agent definition; `--plan` starts in plan mode.",
      "Effort is the `[thinking] effort` key in `~/.kimi-code/config.toml`: low, high, or max.",
    ],
  },
];

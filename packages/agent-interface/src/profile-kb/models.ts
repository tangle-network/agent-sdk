import type { ProfileKbModel } from "./types.js";

const CHECKED = "2026-09-22";
const claudeDocs = "https://platform.claude.com/docs/en";

/**
 * Current frontier models, from vendor sources read on 2026-09-22.
 *
 * `prompt` lines go into the model's prompt; `operator` lines configure the
 * run. Vendor facts carry their source. Nothing here compares one model with
 * another.
 */
export const profileKbModels: readonly ProfileKbModel[] = [
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    vendor: "Anthropic",
    surfaces: ["api", "router"],
    aliases: ["anthropic/claude-opus-5-5", "anthropic.claude-opus-5-5"],
    defaultEffort: "medium",
    sources: [
      { url: `${claudeDocs}/models/opus-5-5/overview`, checkedAt: CHECKED },
      {
        url: `${claudeDocs}/build-with-claude/prompt-engineering/prompting-claude-opus-5-5`,
        checkedAt: CHECKED,
      },
      {
        url: "https://www.anthropic.com/claude-opus-5-5-system-card",
        checkedAt: CHECKED,
        note: "system card, linked from the model overview",
      },
    ],
    prompt: [
      "Keep the task's parts in a checklist you update, and keep working until every item is done or blocked.",
      "Put status notes and recommendations in the same message as your next tool call; end the turn only when the work is complete or nothing can move without the user.",
      "Before acting on a loosely specified task, explore the relevant files, records, and sources, including ones the task does not name, and use what you find.",
      "When a lead agent can delegate, run independent slices in parallel subagents and pace the work to finish early.",
      "For dense charts, diagrams, or screenshots, crop and zoom with the available image tools before reading values.",
    ],
    operator: [
      "Model id claude-opus-5-5; 1M context, 128K max output; released 2026-09-22.",
      "Adaptive thinking is always on. Start at effort medium, measure low for cost, and reserve xhigh and max for measured gains.",
      "Set max_tokens to 128000 for long agentic turns: thinking counts toward it.",
      "Keep history append-only and pass thinking blocks back unchanged; change instructions with mid-conversation system messages.",
      "Set thinking display to updates to receive progress notes between tool calls.",
      "For unattended loops, treat a text-only end of turn as a report: name the open items in a short user message, at most two or three times.",
      "For multi-agent runs, append elapsed time against a budget (for example `elapsed 340s / 1200s`) to each message.",
    ],
  },
  {
    id: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    vendor: "Anthropic",
    surfaces: ["api", "router"],
    aliases: ["anthropic/claude-fable-5-1", "anthropic.claude-fable-5-1"],
    defaultEffort: "high",
    sources: [
      { url: `${claudeDocs}/models/fable-5-1/overview`, checkedAt: CHECKED },
      {
        url: `${claudeDocs}/build-with-claude/prompt-engineering/prompting-claude-fable-5-1`,
        checkedAt: CHECKED,
      },
    ],
    prompt: [
      "You are operating autonomously: for reversible actions that follow from the request, proceed without asking; stop only for destructive actions or scope changes the user must decide.",
      "Before ending your turn, check your last paragraph: if it is a plan, a list of next steps, or a promise, do that work now with tool calls.",
      "The request sets the scope: deliver all of it, keep changes to what it needs, and report other findings as follow-ups.",
      "First privately list what you need next; then request every item that does not depend on another's result in one response.",
      "Say in a line what you are about to do, give brief updates while you work, and close with a recap that stands on its own.",
      "Edit files surgically when a targeted edit gives the same result.",
      "Write plainly: when a literal phrase is available, use it.",
    ],
    operator: [
      "Model id claude-fable-5-1; 1M context, 128K max output; released 2026-09-01. For demanding reasoning and long-horizon agentic work.",
      "Adaptive thinking only. Start at effort high and sweep low, medium, xhigh, and max against your evals.",
      "Keep history append-only; send per-turn reminders as turn-scoped system messages (clear_at next_user_message).",
      "Let the lead agent keep working while subagents run: return from the spawn tool immediately and deliver results in a later user message.",
      "At xhigh and max, leave max_tokens room for thinking plus the deliverable.",
    ],
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    vendor: "Anthropic",
    surfaces: ["api", "router"],
    aliases: ["anthropic/claude-sonnet-5", "anthropic.claude-sonnet-5"],
    defaultEffort: "high",
    sources: [
      { url: `${claudeDocs}/models/overview`, checkedAt: CHECKED },
      {
        url: `${claudeDocs}/build-with-claude/prompt-engineering/prompting-claude-sonnet-5`,
        checkedAt: CHECKED,
      },
    ],
    prompt: [
      "Apply each instruction to every case it names; where an instruction should apply broadly, the prompt says so.",
      "For review work, report every issue you find with a confidence and severity; a later step filters them.",
      "Give regular, short progress updates through long agentic work.",
    ],
    operator: [
      "Model id claude-sonnet-5; 1M context, 128K max output.",
      "Adaptive thinking is on by default. Effort defaults to high; use xhigh for the hardest coding and agentic tasks.",
      "Instructions are followed literally, especially at low effort: state scope explicitly.",
      "Give the task, intent, and constraints up front in the first turn.",
      "Temperature, top_p, and top_k stay at defaults; steer tone and variety in the prompt.",
    ],
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    vendor: "Anthropic",
    surfaces: ["api", "router"],
    aliases: [
      "claude-haiku-4-5-20251001",
      "anthropic/claude-haiku-4-5",
      "anthropic.claude-haiku-4-5",
    ],
    sources: [
      { url: `${claudeDocs}/models/haiku-4-5/overview`, checkedAt: CHECKED },
    ],
    prompt: [
      "Answer directly and keep each step scoped to the task in hand.",
    ],
    operator: [
      "Model id claude-haiku-4-5-20251001 (alias claude-haiku-4-5); 200K context, 64K max output. The fastest model in the current lineup.",
      "Uses manual extended thinking (thinking.type enabled with budget_tokens); it takes no effort parameter.",
      "Retirement not sooner than 2026-10-15.",
    ],
  },
  {
    id: "gpt-6-pro",
    name: "GPT-6 Pro",
    vendor: "OpenAI",
    surfaces: ["chatgpt"],
    aliases: ["GPT-6 Pro"],
    sources: [
      {
        url: "https://help.openai.com/en/articles/20001354-gpt-56-and-gpt-6-pro-in-chatgpt",
        checkedAt: CHECKED,
        note: "read through search results; direct fetch returned HTTP 403",
      },
      { url: "https://learn.chatgpt.com/docs/prompting", checkedAt: CHECKED },
    ],
    prompt: [
      "Start with the result you want, then give the goal, the context that helps, the output format, and what must stay unchanged.",
      "Describe a process only when the process itself matters; otherwise leave room to search, compare, and adjust.",
      "End with a final check: confirm each deliverable and flag anything you could not verify.",
    ],
    operator: [
      "A ChatGPT model mode powered by GPT-6 Astra, on Pro, Business, and Enterprise plans. It has a weekly usage limit.",
      "No API model id; reach it through ChatGPT (chatgpt-fleet).",
    ],
  },
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    vendor: "OpenAI",
    surfaces: ["codex", "api", "router"],
    aliases: ["openai/gpt-5.6-sol"],
    defaultEffort: "medium",
    sources: [
      {
        url: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
        checkedAt: CHECKED,
      },
      {
        url: "https://openai.com/index/builders-guide-to-gpt-5-6/",
        checkedAt: CHECKED,
        note: "read through search results; direct fetch returned HTTP 403",
      },
      {
        url: "file://~/.codex/models_cache.json",
        checkedAt: CHECKED,
        note: "codex-cli 0.152.1 served list; `codex exec -m gpt-5.6-sol` returned OK",
      },
    ],
    prompt: [
      "Work from the outcome: know what good looks like and the stopping condition, then choose the method yourself.",
      "Carry the task to completion: gather context, plan, implement, verify, and report the evidence.",
      "Run independent reads and checks in parallel.",
    ],
    operator: [
      "Flagship GPT-5.6 tier for complex professional work: architecture, security review, repo-wide debugging.",
      "Keep the system prompt lean: objective, context, hard constraints, approval boundaries, success criteria, required evidence, and output format.",
      "Efforts: none, low, medium (API default), high, xhigh, max; Codex adds ultra, which runs parallel agents. Codex lists low as its default for this model.",
      "1,050,000-token context, 128K max output.",
    ],
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    vendor: "OpenAI",
    surfaces: ["codex", "api", "router"],
    aliases: ["openai/gpt-5.6-terra"],
    defaultEffort: "medium",
    sources: [
      {
        url: "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
        checkedAt: CHECKED,
      },
      {
        url: "file://~/.codex/models_cache.json",
        checkedAt: CHECKED,
        note: "codex-cli 0.152.1 served list; `codex exec -m gpt-5.6-terra` returned OK",
      },
    ],
    prompt: [
      "Work from the outcome and the stopping condition; choose the method yourself and verify before you report.",
    ],
    operator: [
      "Balanced GPT-5.6 tier for everyday professional coding.",
      "Efforts: none, low, medium (default), high, xhigh, max; Codex adds ultra.",
      "1,050,000-token context, 128K max output.",
    ],
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    vendor: "OpenAI",
    surfaces: ["codex", "api", "router"],
    aliases: ["openai/gpt-5.6-luna"],
    defaultEffort: "medium",
    sources: [
      {
        url: "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
        checkedAt: CHECKED,
      },
      {
        url: "file://~/.codex/models_cache.json",
        checkedAt: CHECKED,
        note: "codex-cli 0.152.1 served list; `codex exec -m gpt-5.6-luna` returned OK",
      },
    ],
    prompt: [
      "Follow the stated format exactly and finish each item before moving to the next.",
    ],
    operator: [
      "GPT-5.6 tier for cost-sensitive, high-volume work: summarizing, labeling, extraction, scaffolds.",
      "Efforts: none, low, medium (default), high, xhigh, max. Raise effort for harder items.",
      "1,050,000-token context, 128K max output.",
    ],
  },
  {
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    vendor: "DeepSeek",
    surfaces: ["api", "router"],
    aliases: ["deepseek-flash", "deepseek/deepseek-v4.1-flash"],
    sources: [
      {
        url: "https://api-docs.deepseek.com/news/news260910/",
        checkedAt: CHECKED,
      },
      {
        url: "https://api-docs.deepseek.com/quick_start/pricing",
        checkedAt: CHECKED,
      },
      {
        url: "https://router.tangle.tools/v1/chat/completions",
        checkedAt: CHECKED,
        note: "deepseek/deepseek-v4.1-flash returned HTTP 200 and served that id",
      },
    ],
    prompt: [
      "State the goal and the finished result up front, and use the tools you are given to check your work.",
    ],
    operator: [
      "Vendor API id deepseek-flash (released 2026-09-10); on the Tangle router, deepseek/deepseek-v4.1-flash.",
      "1M context, 384K max output; thinking mode is the default and non-thinking is available. Native vision.",
      "OpenCode supports it as an official partner harness.",
    ],
  },
  {
    id: "glm-5.3",
    name: "GLM-5.3",
    vendor: "Z.ai",
    surfaces: ["api", "router"],
    aliases: ["z-ai/glm-5.3", "zai-coding-plan/glm-5.3"],
    defaultEffort: "ultracode",
    sources: [
      { url: "https://docs.z.ai/guides/llm/glm-5.3", checkedAt: CHECKED },
      {
        url: "https://router.tangle.tools/v1/chat/completions",
        checkedAt: CHECKED,
        note: "glm-5.3 returned HTTP 200, served as z-ai/glm-5.3",
      },
    ],
    prompt: [
      "Work the task through to a verified result, using the tools to run and check each change.",
    ],
    operator: [
      "Model id glm-5.3; text only; 1M context, 128K max output. Built for long-horizon software engineering.",
      "Reasoning is always on: thinking.type enabled with reasoning_effort low, high, or max (default). Use max for coding.",
    ],
  },
  {
    id: "kimi-k3",
    name: "Kimi K3",
    vendor: "Moonshot AI",
    surfaces: ["api", "router"],
    aliases: ["moonshotai/kimi-k3", "kimi-code/k3"],
    defaultEffort: "ultracode",
    sources: [
      {
        url: "https://platform.kimi.ai/docs/guide/kimi-k3-quickstart",
        checkedAt: CHECKED,
      },
      {
        url: "https://router.tangle.tools/v1/chat/completions",
        checkedAt: CHECKED,
        note: "kimi-k3 returned HTTP 200, served as moonshotai/kimi-k3",
      },
    ],
    prompt: [
      "Navigate the repository, run the code, and iterate against tests, logs, and runtime output until the result holds.",
    ],
    operator: [
      "Model id kimi-k3; 1M context; native vision. For long-horizon coding, knowledge work, and reasoning.",
      "Thinking is always on: reasoning_effort low, high, or max (default).",
      "Sampling is fixed (temperature 1.0, top_p 0.95); omit sampling parameters.",
      "Return the complete assistant message unchanged in multi-turn and tool-call histories.",
    ],
  },
];

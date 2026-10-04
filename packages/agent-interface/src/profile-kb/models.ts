import type { ProfileKbModel, ProfileKbSource } from "./types.js";
import { claim, kbEntry } from "./entry.js";

const CHECKED = "2026-10-04";
const source = (url: string, locator: string): ProfileKbSource => ({
  url,
  locator,
  checkedAt: CHECKED,
  authority: "primary",
});
const claudeDocs = "https://platform.claude.com/docs/en";
const opusGuide = source(
  `${claudeDocs}/build-with-claude/prompt-engineering/prompting-claude-opus-5-5`,
  "Tools for complex visual inputs; unattended agentic runs; time signals for multiagent harnesses",
);
const fableGuide = source(
  `${claudeDocs}/build-with-claude/prompt-engineering/prompting-claude-fable-5-1`,
  "Finish the whole task; batch independent tool calls; keep the conversation history append-only",
);
const sonnetGuide = source(
  `${claudeDocs}/build-with-claude/prompt-engineering/prompting-claude-sonnet-5`,
  "Code review harnesses; tone and writing style",
);
const deepseekModel = source(
  "https://api-docs.deepseek.com/quick_start/pricing/#model-details",
  "Model details; footnote 1",
);
const deepseekThinking = source(
  "https://api-docs.deepseek.com/guides/thinking_mode/",
  "Thinking mode toggle and effort control; tool calls",
);
const glmModel = source(
  "https://docs.z.ai/guides/llm/glm-5.3#feature-changes",
  "Feature changes",
);
const kimiModel = source(
  "https://platform.kimi.ai/docs/guide/kimi-k3-quickstart",
  "Reasoning effort; vision input; important limits",
);

/** Historical acceptance records, not a current serving or quality check. */
function routerClaim(note: string) {
  return claim(
    `The 2026-09-22 record reports ${note}; this audit recovered no attached trace and made no new router request.`,
    {
      url: "https://router.tangle.tools/v1/chat/completions",
      checkedAt: "2026-09-22",
      authority: "local",
      locator: "models.ts at d949682; historical routerCheck note",
    },
    "local-observation",
  );
}

/** Each row refers to the dated catalog in the retained source audit. */
function codexCatalogClaim(
  id: string,
  defaultEffort: "low" | "medium",
  ultra: boolean,
) {
  return claim(
    `Codex cache observed at 2026-10-04T05:31:58Z (client 0.160.0): 272000 context, default ${defaultEffort}, efforts low through max${ultra ? " plus ultra" : ""}. This account/client catalog is not a serving receipt; a later cache written by 0.155.0 lacked GPT-6.1 Sol.`,
    {
      url: "file://~/.codex/models_cache.json",
      checkedAt: CHECKED,
      authority: "local",
      locator: `research/anthropic-openai.md#local-codex-catalog-evidence; slug ${id}`,
    },
    "local-observation",
  );
}

function historicalCodexClaim(id: string, catalogSource: boolean) {
  const note = catalogSource
    ? `codex-cli 0.156.1 served list; \`codex exec -m ${id}\` returned OK`
    : "codex-cli 0.156.1 on a ChatGPT account returned OK";
  return claim(
    `The 2026-09-22 record reports ${note}; no attached trace was recovered in this audit.`,
    {
      url: catalogSource
        ? "file://~/.codex/models_cache.json"
        : `cli:codex exec -m ${id} 'Reply with exactly: OK'`,
      checkedAt: "2026-09-22",
      note,
      authority: "local",
      locator: "models.ts at d949682; historical CLI check",
    },
    "local-observation",
  );
}

/** Source-backed facts and conditional advice. API controls never become agent instructions. */
export const profileKbModels: readonly ProfileKbModel[] = [
  kbEntry({
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    vendor: "Anthropic",
    surfaces: ["api"],
    aliases: ["anthropic/claude-opus-5-5", "anthropic.claude-opus-5-5"],
    defaultEffort: "medium",
    claims: [
      claim(
        "Claude API: 1M context, 128K ordinary output; adaptive thinking is always enabled, default effort medium. Preserve returned thinking and its conversation prefix.",
        source(
          "https://platform.claude.com/docs/en/models/opus-5-5/overview",
          "Overview; capabilities; good to know",
        ),
      ),
      claim(
        "For dense charts or screenshots, inspect small details using available crop or zoom tools.",
        opusGuide,
        "vendor-guidance",
        "agent",
      ),
      claim(
        "For unattended runs that stop with unfinished work, explicit completion tracking and bounded continuation are vendor tuning candidates; interactive confirmations still apply.",
        opusGuide,
        "vendor-guidance",
      ),
      claim(
        "For an already-authorized agent team, elapsed-time and budget signals are a tuning candidate; hard timeouts need enforcement outside the prompt, and time pressure can reduce verification.",
        opusGuide,
        "vendor-guidance",
      ),
    ],
  }),
  kbEntry({
    id: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    vendor: "Anthropic",
    surfaces: ["api"],
    aliases: ["anthropic/claude-fable-5-1", "anthropic.claude-fable-5-1"],
    defaultEffort: "high",
    claims: [
      claim(
        "Claude API: 1M context, 128K ordinary output; always-on adaptive thinking, default effort high.",
        source(
          "https://platform.claude.com/docs/en/models/fable-5-1/overview",
          "Overview; capabilities",
        ),
      ),
      claim(
        "The vendor offers optional remedies for demonstrated early stopping, serial independent calls, overediting and writing problems. Apply the matching remedy within the task scope and authorization.",
        fableGuide,
        "vendor-guidance",
      ),
      claim(
        "Keep history append-only; supported turn-scoped reminders remain appended. When subagents are already used, nonblocking spawn and later results let the lead continue, but do not guarantee useful overlap.",
        fableGuide,
        "vendor-guidance",
      ),
    ],
  }),
  kbEntry({
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    vendor: "Anthropic",
    surfaces: ["api", "router"],
    aliases: ["anthropic/claude-sonnet-5", "anthropic.claude-sonnet-5"],
    defaultEffort: "high",
    claims: [
      claim(
        "Claude API: active legacy model; 1M context, 128K output. Adaptive thinking defaults on with effort high; disabled thinking is also supported.",
        source(
          "https://platform.claude.com/docs/en/models/sonnet-5/overview",
          "Capabilities; availability",
        ),
      ),
      claim(
        "For review, specify the desired precision/recall and name any actual downstream filter; do not invent one to justify broad reporting.",
        sonnetGuide,
        "vendor-guidance",
      ),
      claim(
        "Nondefault temperature, top_p and top_k are rejected.",
        sonnetGuide,
      ),
      routerClaim("claude-sonnet-5 returned HTTP 200"),
    ],
  }),
  kbEntry({
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    vendor: "Anthropic",
    surfaces: ["api"],
    aliases: ["anthropic/claude-sonnet-5-5", "anthropic.claude-sonnet-5-5"],
    defaultEffort: "high",
    claims: [
      claim(
        "Claude API: released 2026-09-28; 1M context, 128K output; adaptive thinking with default effort high. between_tools is the lowest thinking setting and requires effort high or below; do not reuse Sonnet 5 disabled-thinking assumptions.",
        source(
          "https://platform.claude.com/docs/en/models/sonnet-5-5/overview",
          "Overview; capabilities; good to know",
        ),
      ),
    ],
  }),
  kbEntry({
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    vendor: "Anthropic",
    surfaces: ["api"],
    aliases: [
      "claude-haiku-4-5-20251001",
      "anthropic/claude-haiku-4-5",
      "anthropic.claude-haiku-4-5",
    ],
    claims: [
      claim(
        "Claude API alias claude-haiku-4-5 resolves to claude-haiku-4-5-20251001; 200K context, 64K output. Manual extended thinking uses budget_tokens and accepts no effort parameter. Retirement is not before 2026-10-15, not scheduled on that date.",
        source(
          "https://platform.claude.com/docs/en/models/haiku-4-5/overview",
          "Model IDs; capabilities; availability",
        ),
      ),
    ],
  }),
  kbEntry({
    id: "gpt-6-pro",
    name: "GPT-6 Pro",
    vendor: "OpenAI",
    surfaces: ["chatgpt"],
    aliases: ["GPT-6 Pro"],
    claims: [
      claim(
        "GPT-6 Pro is a ChatGPT product mode powered by Astra, with plan/workspace-dependent access and allowances. This entry establishes no API model ID.",
        source(
          "https://help.openai.com/en/articles/20001354-gpt-56-and-gpt-6-pro-in-chatgpt",
          "GPT-6 Pro availability; usage limits",
        ),
      ),
    ],
  }),
  kbEntry({
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    vendor: "OpenAI",
    surfaces: ["codex", "api"],
    aliases: ["openai/gpt-6.1-sol"],
    defaultEffort: "medium",
    claims: [
      claim(
        "OpenAI API: 1,050,000-token context, 128K output; efforts low, medium, high, xhigh and max. API default is medium. Tool calling requires Responses.",
        source(
          "https://developers.openai.com/api/docs/models/gpt-6.1-sol",
          "Model description; reasoning effort; context/output limits; supported endpoints",
        ),
      ),
      codexCatalogClaim("gpt-6.1-sol", "low", true),
    ],
  }),
  kbEntry({
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    vendor: "OpenAI",
    surfaces: ["codex", "api"],
    aliases: ["openai/gpt-6-astra"],
    defaultEffort: "medium",
    claims: [
      claim(
        "OpenAI API: 1,050,000-token context, 128K output; efforts low, medium, high, xhigh and max. Tool calling requires Responses.",
        source(
          "https://developers.openai.com/api/docs/models/gpt-6-astra",
          "Model description; reasoning effort; context/output limits; supported endpoints",
        ),
      ),
      codexCatalogClaim("gpt-6-astra", "medium", true),
      claim(
        "The GPT-6 guide describes Astra prompting patterns; delegation, autonomy and testing examples remain conditional on tools, authorization and workload. Other family members need their own evaluation.",
        source(
          "https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra",
          "Prompting best practices; subagent delegation; testing and verification",
        ),
        "vendor-guidance",
      ),
      historicalCodexClaim("gpt-6-astra", false),
    ],
  }),
  kbEntry({
    id: "gpt-6-sol",
    name: "GPT-6 Sol",
    vendor: "OpenAI",
    surfaces: ["codex", "api"],
    aliases: ["openai/gpt-6-sol"],
    defaultEffort: "medium",
    claims: [
      claim(
        "OpenAI API: 1,050,000-token context, 128K output; efforts none, low, medium, high, xhigh and max. API default is medium. Responses supports tools; Chat Completions function calling requires effort none.",
        source(
          "https://developers.openai.com/api/docs/models/gpt-6-sol",
          "Model description; reasoning effort; context/output limits; supported endpoints",
        ),
      ),
      codexCatalogClaim("gpt-6-sol", "medium", true),
      historicalCodexClaim("gpt-6-sol", false),
    ],
  }),
  kbEntry({
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    vendor: "OpenAI",
    surfaces: ["codex", "api"],
    aliases: ["openai/gpt-6-luna"],
    defaultEffort: "medium",
    claims: [
      claim(
        "OpenAI API: 1,050,000-token context, 128K output; efforts none, low, medium, high, xhigh and max. API default is medium. Responses supports tools; Chat Completions function calling requires effort none.",
        source(
          "https://developers.openai.com/api/docs/models/gpt-6-luna",
          "Model description; reasoning effort; context/output limits; supported endpoints",
        ),
      ),
      codexCatalogClaim("gpt-6-luna", "medium", false),
      historicalCodexClaim("gpt-6-luna", false),
    ],
  }),
  kbEntry({
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    vendor: "OpenAI",
    surfaces: ["codex", "api", "router"],
    aliases: ["openai/gpt-5.6-sol"],
    defaultEffort: "medium",
    claims: [
      claim(
        "OpenAI API: 1,050,000-token context, 128K output; efforts none, low, medium, high, xhigh and max. API default is medium.",
        source(
          "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
          "Model description; reasoning effort; context/output limits; supported endpoints",
        ),
      ),
      claim(
        "OpenAI API name gpt-5.6 aliases to gpt-5.6-sol.",
        source(
          "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
          "Model description; reasoning effort; context/output limits; supported endpoints",
        ),
      ),
      codexCatalogClaim("gpt-5.6-sol", "low", true),
      historicalCodexClaim("gpt-5.6-sol", true),
      routerClaim("gpt-5.6-sol returned HTTP 200"),
    ],
  }),
  kbEntry({
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    vendor: "OpenAI",
    surfaces: ["codex", "api", "router"],
    aliases: ["openai/gpt-5.6-terra"],
    defaultEffort: "medium",
    claims: [
      claim(
        "OpenAI API: 1,050,000-token context, 128K output; efforts none, low, medium, high, xhigh and max. API default is medium.",
        source(
          "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
          "Model description; reasoning effort; context/output limits; supported endpoints",
        ),
      ),
      codexCatalogClaim("gpt-5.6-terra", "medium", true),
      historicalCodexClaim("gpt-5.6-terra", true),
      routerClaim("gpt-5.6-terra returned HTTP 200"),
    ],
  }),
  kbEntry({
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    vendor: "OpenAI",
    surfaces: ["codex", "api", "router"],
    aliases: ["openai/gpt-5.6-luna"],
    defaultEffort: "medium",
    claims: [
      claim(
        "OpenAI API: 1,050,000-token context, 128K output; efforts none, low, medium, high, xhigh and max. API default is medium.",
        source(
          "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
          "Model description; reasoning effort; context/output limits; supported endpoints",
        ),
      ),
      codexCatalogClaim("gpt-5.6-luna", "medium", false),
      historicalCodexClaim("gpt-5.6-luna", true),
      routerClaim("gpt-5.6-luna returned HTTP 200"),
    ],
  }),
  kbEntry({
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    vendor: "DeepSeek",
    surfaces: ["api", "router"],
    aliases: ["deepseek-flash", "deepseek/deepseek-v4.1-flash"],
    claims: [
      claim(
        "DeepSeek API ID deepseek-flash denotes V4.1-Flash: 1M context, 384K output, vision and tools; non-thinking mode is available. Router naming is a separate contract.",
        deepseekModel,
      ),
      claim(
        "Thinking defaults on at high. Native efforts are low, high and max; minimal maps to low, medium/xhigh to high, and ultra to max. With tools, preserve all previous reasoning_content, including turns without tool calls.",
        deepseekThinking,
      ),
      routerClaim(
        "deepseek/deepseek-v4.1-flash returned HTTP 200 and served that id",
      ),
    ],
  }),
  kbEntry({
    id: "glm-5.3",
    name: "GLM-5.3",
    vendor: "Z.ai",
    surfaces: ["api", "router"],
    aliases: ["z-ai/glm-5.3", "zai-coding-plan/glm-5.3"],
    defaultEffort: "ultracode",
    claims: [
      claim(
        "Z.ai direct API: text-only, 1M context, 128K output; thinking cannot be disabled. reasoning_effort accepts only low, high or max, default max.",
        glmModel,
      ),
      claim(
        "Coding Plan maps none/minimal/low to low, medium/high to high, and xhigh/max to max; this mapping does not apply to direct GLM-5.3 API requests.",
        source(
          "https://docs.z.ai/guides/capabilities/thinking#core-parameters",
          "Core parameters; Coding Plan mappings",
        ),
      ),
      claim(
        "Z.ai recommends max for complex coding; no local effort sweep establishes its value for this workload.",
        glmModel,
        "vendor-guidance",
      ),
      routerClaim("glm-5.3 returned HTTP 200, served as z-ai/glm-5.3"),
    ],
  }),
  kbEntry({
    id: "kimi-k3",
    name: "Kimi K3",
    vendor: "Moonshot AI",
    surfaces: ["api", "router"],
    aliases: ["moonshotai/kimi-k3", "kimi-code/k3"],
    defaultEffort: "ultracode",
    claims: [
      claim(
        "Moonshot API ID kimi-k3: 1M context, native vision, always-on thinking; reasoning_effort low, high or max, default max. The CLI alias kimi-code/k3 belongs to a different configuration surface.",
        kimiModel,
      ),
      claim(
        "Omit fixed sampling fields. Replay complete assistant messages unchanged, including reasoning and tool calls. Vision uses structured base64 or uploaded-file content, not public image URLs.",
        kimiModel,
      ),
      claim(
        "For large tool catalogs, tool search followed by dynamic declarations is vendor guidance; the backend must implement retrieval and the K3-specific declaration protocol.",
        source(
          "https://platform.kimi.ai/docs/guide/kimi-k3-tool-calling-best-practice",
          "Declare a search tool; use tool_choice; inject tool definitions",
        ),
        "vendor-guidance",
      ),
      routerClaim("kimi-k3 returned HTTP 200, served as moonshotai/kimi-k3"),
    ],
  }),
];

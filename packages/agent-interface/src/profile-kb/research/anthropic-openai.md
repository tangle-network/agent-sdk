# Anthropic and OpenAI record audit

Checked **2026-10-04 UTC**, against `models.ts`, `harnesses.ts`, and `records.ts` at
`d949682`. This is source research, not a platform evaluation. No inference calls,
paid runs, router checks, or production changes were made. Apply the owning
[applicability contract](../../../README.md#applicability-and-evidence) before
promoting any recommendation.

Every web source below was opened and its primary content read on that date,
except the explicitly unfetched system card. Section names are locators within
the linked source. Search snippets were discovery aids only. Vendor performance
statements remain vendor statements; none establishes a benefit for our profiles.

## Changes the evidence supports

- Preserve Sonnet 5 as an active legacy model; add Sonnet 5.5 separately. Add
  GPT-6.1 Sol separately and stop describing GPT-6 Sol as the newest Sol.
- Keep API specifications separate from observed Codex catalog settings. A
  model-wide `defaultEffort` cannot express both when their defaults differ.
- Make autonomy, delegation, progress, and review prompts conditional on the
  selected workflow and observed problem. A supported tool is not authorization
  to use it, and a vendor example is not a universally required instruction.
- Preserve dated historical checks without refreshing their dates. HTTP 200 or
  an `OK` response does not establish served identity, task quality, or cost.

## Anthropic models

| Record / claim | Supported compressed wording | Source and locator; applicability / disposition |
| --- | --- | --- |
| `claude-opus-5-5`: identity, limits, thinking | Claude API ID `claude-opus-5-5`; released 2026-09-22; 1M context, 128K ordinary output; adaptive thinking always enabled, default effort `medium`. Preserve returned thinking and its conversation prefix. | [Opus overview](https://platform.claude.com/docs/en/models/opus-5-5/overview), **Overview**, **Capabilities**, **Availability**. Retain as API facts. Batch beta permits 300K output; 128K is not a limit for every endpoint. The overview documents forced-tool-use and thinking-binding changes that an integration must assess. |
| Opus prompt checklist, end-turn behavior, `max_tokens`, progress | For unattended runs that stop with unfinished work, try explicit completion tracking and bounded continuation. Leave output room for thinking. Configure progress-block rendering before adding narration prompts. | [Opus prompting](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5), **Calibrate effort**, **Unattended agentic runs**, **User-facing progress updates**. Vendor trials support 128000 for long agentic turns, not every request. The unattended prompt excludes interactive applications and preserves confirmations; continuation is capped at two or three. `display: "updates"` requires its beta header. |
| Opus exploration, parallel agents, elapsed time, crop/zoom | Explore potentially relevant connected sources for underspecified multi-app tasks. If an authorized team already exists, elapsed time/budget signals are a tuning candidate; enforce hard timeouts separately. Supply crop/zoom tools for dense visual inputs when needed. | Same **Opus prompting** source, **Explore context in multi-app workflows**, **Time signals for multiagent harnesses**, **Tools for complex visual inputs**. Do not generalize multi-app results to every repository task, require delegation, or promise speedup. Time pressure can reduce verification; visual scaffolding should be retested rather than universally imposed. |
| `claude-fable-5-1`: identity, limits, effort | Claude API ID `claude-fable-5-1`; released 2026-09-01; 1M context, 128K ordinary output; always-on adaptive thinking, default `high`. | [Fable overview](https://platform.claude.com/docs/en/models/fable-5-1/overview), **Capabilities**, **Availability**, **Overview**. Retain API facts. “Demanding reasoning / long-horizon work” is vendor positioning, not demonstrated superiority for this platform. Its overview still says start with Opus 5, while the current [lineup](https://platform.claude.com/docs/en/models/overview), **Compare models**, says Opus 5.5: preserve this documentation drift rather than derive a universal preference. |
| Fable autonomy/completion/scope, batching, style, surgical edits | Tune a demonstrated early-stop, serial-call, overediting, or writing problem using the corresponding vendor pattern. Preserve requested scope and authorization. | [Fable prompting](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1), **Finish the whole task**, **Keep changes and tests to what the task asks for**, **Batch independent tool calls in agent loops**, **Writing density**, **Prefer targeted edits over whole-file rewrites**. Autonomy example assumes an absent user and explicitly distinguishes assessment from implementation. Batch only independent calls. These are optional remedies, not model requirements. |
| Fable progress, append-only history, async subagents, high-effort output | Check progress rendering and remove suppressive prompts first. Preserve history; supported turn-scoped reminders remain appended. If subagents are already used, nonblocking spawn plus later result delivery can let the lead continue. Budget thinking and output together. | Same **Fable prompting** source, **Ask for user-facing progress updates**, **Keep the conversation history append-only**, **Let the lead agent keep working while subagents run**, **Leave room for long outputs at xhigh and max effort**. Relevant features have beta/account conditions. Asynchronous spawn does not guarantee useful concurrent lead work; the guide says the lead often still waits. |
| `claude-sonnet-5`: API limits / status | Sonnet 5 remains active **legacy**, with 1M context and 128K output. Adaptive thinking defaults on; effort defaults to `high`; disabled thinking remains supported. | [Sonnet 5 overview](https://platform.claude.com/docs/en/models/sonnet-5/overview), **Capabilities**, **Availability**; [Sonnet 5 prompting](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5), **Calibrating effort and thinking depth**. Replace the moving lineup citation with this exact model page. Do not transfer its disabled-thinking contract to Sonnet 5.5. |
| Sonnet literal scope, review recall, progress, first-turn context, sampling | State the intended scope. Tune review reporting against the desired precision/recall; if a downstream filter exists, name it. Specify progress needs. Provide known task constraints up front. Nondefault sampling parameters are rejected. | Same **Sonnet 5 prompting** source, **More literal instruction following**, **Code review harnesses**, **User-facing progress updates**, **Interactive coding products**, **Tone and writing style**. “A later step filters them” is false when no such consumer exists. The guide permits concrete single-pass filtering too. `xhigh` is a vendor candidate for difficult work, not a universal setting or authorization to reduce user involvement. |
| `claude-sonnet-5-5`: missing current entry | Separate ID `claude-sonnet-5-5`, released 2026-09-28; 1M/128K, adaptive thinking, default `high`. `between_tools` is the lowest thinking setting, at `high` or below. | [Sonnet 5.5 overview](https://platform.claude.com/docs/en/models/sonnet-5-5/overview), **Overview**, **Capabilities**, **Availability**, **Good to know**. New thinking, forced-tool-use, thinking-binding, and progress response behavior make it unsafe to alias to Sonnet 5. Its [own prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5) was fetched; no local behavioral result exists. |
| `claude-haiku-4-5`: specs / generic prompt / retirement | Alias resolves to `claude-haiku-4-5-20251001`; 200K context, 64K output. Manual extended thinking uses `budget_tokens`; no effort control. Retirement is **not before** 2026-10-15, not a scheduled shutdown on that date. | [Haiku overview](https://platform.claude.com/docs/en/models/haiku-4-5/overview), **Model IDs**, **Capabilities**, **Availability**, **Good to know**. Retain API facts. The cited overview does not establish “answer directly and keep each step scoped” as model-specific advice; remove it from model evidence or label it an application preference. |

The existing [Opus system-card URL](https://www.anthropic.com/claude-opus-5-5-system-card)
is linked by the overview, but both direct open and following that link failed
in this audit. Mark its contents **unfetched**, not confirmed. No catalog claim
above relies on it. Provider-prefixed aliases are selector spellings, not proof
that a particular provider or router currently serves the requested model.

## OpenAI model and surface facts

Each API page below was read at its model description, reasoning-effort text,
context/output limits, and relevant endpoint or pricing notes. All listed API
models advertise 1,050,000 context and 128,000 output tokens. This is an API
specification, not the context configured in a Codex run.

| Record | Supported API wording / change | Primary source; conditional applicability |
| --- | --- | --- |
| `gpt-6-astra` | Efforts `low`, `medium`, `high`, `xhigh`, `max`; no `none`. Tool calling requires Responses. | [Astra model](https://developers.openai.com/api/docs/models/gpt-6-astra), model description/limits; [GPT-6 guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra), **Update API and model parameters**. API support does not establish enabled tools or account access. |
| `gpt-6-sol` | Efforts `none` through `max`, API default `medium`. Responses supports tools; Chat Completions function calling requires `none`. Newer Sol exists. | [Sol model](https://developers.openai.com/api/docs/models/gpt-6-sol), model description/limits/pricing. Retain exact old identity. Above 272K input, the documented full-request price multipliers are 2× input/cache and 1.5× output; these are tariff facts, not measured task cost. |
| `gpt-6-luna` | Efforts `none` through `max`, API default `medium`; same endpoint restriction as GPT-6 Sol. | [Luna model](https://developers.openai.com/api/docs/models/gpt-6-luna), model description/limits. Focused high-volume work is vendor positioning. Do not infer that complex work is impossible or that sequential execution is required. |
| `gpt-5.6-sol` | GPT-5.6 flagship tier; `gpt-5.6` aliases to it. API efforts `none` through `max`, default `medium`. | [5.6 Sol model](https://developers.openai.com/api/docs/models/gpt-5.6-sol), model description/limits. “Flagship” is within the 5.6 family. Local Codex catalog default is separately `low`; do not expose API `medium` as a universal default. |
| `gpt-5.6-terra` | Vendor describes a capability/cost balance; API efforts `none` through `max`, default `medium`. | [5.6 Terra model](https://developers.openai.com/api/docs/models/gpt-5.6-terra), model description/limits. No platform comparison or everyday-coding optimum established. |
| `gpt-5.6-luna` | Vendor positions it for cost-sensitive high-volume work; API efforts `none` through `max`, default `medium`. | [5.6 Luna model](https://developers.openai.com/api/docs/models/gpt-5.6-luna), model description/limits. “Finish each item before moving to the next” has no demonstrated model-specific basis; retire that serial-execution rule. |
| Missing `gpt-6.1-sol` | Separate current model; API default `medium`, efforts `low` through `max`, no `none` or `minimal`. Tool calling requires Responses; Chat Completions has no tool calling. | [6.1 Sol model](https://developers.openai.com/api/docs/models/gpt-6.1-sol), model description/limits; [Codex models](https://learn.chatgpt.com/docs/models), **Recommended models / GPT-6.1 Sol**. Catalog availability varies by account, client and workspace; neither page is a serving receipt. |
| `gpt-6-pro` | ChatGPT option powered by Astra, with plan/workspace-dependent access and allowances. Treat it as a product mode, not an API model ID. | [Help article](https://help.openai.com/en/articles/20001354-gpt-56-and-gpt-6-pro-in-chatgpt), **GPT-6 Pro availability**, **GPT-6 Pro and GPT-5.6 Sol Pro limits**. Full content fetched successfully; remove the stale “search results only / HTTP 403” note. Weekly/shared/daily allowance rules differ by plan. The fetched article does not independently prove the absolute negative “no API model id”; say no API ID was established for this product-mode entry. `chatgpt-fleet` is our access mechanism, not an OpenAI requirement. |

### Prompt claims and their proper scope

| Existing claims | Distillation / disposition | Source and locator |
| --- | --- | --- |
| Astra initiative, writing, delegation; Sol action-request and skill-priority rules; Luna test scaling | These are optional GPT-6 tuning patterns for autonomy, instruction conflicts, output style and testing. Match authorization and required checks; enable delegation only for an authorized workflow with the tools and a useful independent task. | [GPT-6 guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra), **Prompting best practices**, **Initiative and follow-through**, **Instruction following**, **Personality and writing style**, **Subagent delegation**, **Testing and verification**. The guide explicitly says its observations concern Astra and other family members need evaluation. The `?model=gpt-6-sol` URL returns the same family guide; it is not Sol-specific measured evidence. |
| 5.6 outcome-led work, lean prompts, parallel checks | Preserve goal, constraints, evidence and completion criteria. Remove redundant instructions one group at a time only after checking the same tasks. Independent work may parallelize where appropriate; do not force it. | [GPT-6 guide's **Using GPT-5.6 / Favor leaner prompts / Define autonomy and approval boundaries**](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra); [Builder's guide](https://openai.com/index/builders-guide-to-gpt-5-6/), dated 2026-08-13, **A better out-of-the-box experience**, **Multi-agent**. Both fetched. Internal eval ranges and startup testimonials are hypothesis-generating evidence, not measured savings here. Update the old snippet-only note; do not copy performance percentages into platform learnings. |
| GPT-6 Pro result/context/format/boundaries/final check | Generic ChatGPT prompting guidance, usable when relevant; not a GPT-6 Pro behavioral constraint. | [Prompting](https://learn.chatgpt.com/docs/prompting), **Prompting overview**, **Describe the result you need**, **Make the result ready to use**. The guide expressly allows short prompts and says to include only useful elements. |

### Local Codex catalog evidence

Read-only commands: `codex --version` returned **0.160.0**;
`codex --help`, `codex exec --help`, and `codex features list` were inspected.
The latter listed `multi_agent` and `goals` as stable/enabled. These are local
capability observations, not evidence of authorization, tool exposure in every
profile, model invocation, or quality.

At the first read, `$HOME/.codex/models_cache.json` reported
`fetched_at=2026-10-04T05:31:58.904252Z`, `client_version=0.160.0`:

| Catalog IDs | Advertised default | Advertised efforts | Context |
| --- | --- | --- | --- |
| `gpt-6.1-sol`, `gpt-5.6-sol` | `low` | low, medium, high, xhigh, max, ultra | 272000 |
| `gpt-6-astra`, `gpt-6-sol`, `gpt-5.6-terra` | `medium` | low, medium, high, xhigh, max, ultra | 272000 |
| `gpt-6-luna`, `gpt-5.6-luna` | `medium` | low, medium, high, xhigh, max | 272000 |

Locators: `models[]` matched by `slug`; fields `default_reasoning_level`,
`supported_reasoning_levels`, `context_window`, `description`. GPT-6.1 Sol was
labelled latest workhorse, GPT-6 Sol previous generation, and GPT-5.6 tiers older.
Only public catalog metadata was used; account identity was not copied.

**Mutable-source limit:** a later read during this audit reported
`fetched_at=2026-10-04T05:34:05.857680Z`, `client_version=0.155.0` and lacked
GPT-6.1 Sol. This audit did not modify the cache. Do not equate installed CLI
version with the writer/version of a shared cache or silently overwrite the
earlier observation. An actual run needs its effective configuration and served
identity from run evidence. Historical 0.156.1 `OK`/HTTP-200 notes in the KB
remain dated claims with no attached trace recovered here.

## Harnesses and record disposition

| Record / claim | Checked wording and action | Source / locator and limits |
| --- | --- | --- |
| Claude Code launch/config flags | Observed installed version **2.1.289**. `-p`, `--model`, `--effort`, `--output-format`, append/replace prompt, budget, JSON schema and MCP flags exist. `--bg` returns immediately but cannot combine with `-p`. | Local `claude --version`, `claude --help`; [CLI reference](https://code.claude.com/docs/en/cli-reference), respective flag rows. Budget is per print invocation; restored prior spend is excluded. No launched-session behavior was tested. |
| Claude Code `--bare`, skills, background/subagent advice | Describe what discovery is skipped, rather than “all skills unavailable.” Keep optional procedures conditional. A background session is a capability, not a completion receipt. | Same CLI reference, **--bare**, **--bg**, **System prompt flags in resumed conversations**; local help. Explicit skills/context can still load. Local help additionally specifies API-key/helper authentication for bare mode. Prompt changes on resume may wait until compaction because the original prompt is recorded. Do not recommend bare mode as a generic speed fix. |
| Codex launch, schema, review, replacement, resume/fork/goal | Installed **0.160.0** help supports the existing exec invocation, output schema, review, resume and fork. Replacement uses `model_instructions_file`; effort is model/client dependent. `/goal` tracks an interactive session objective. | Local help; [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), `model_instructions_file`, `model_reasoning_effort`; [Developer commands](https://learn.chatgpt.com/docs/developer-commands), **Set or view a task goal with /goal**. A schema does not establish semantic correctness; goal support is not a host restart/recovery guarantee. |
| Codex unconditional delegation; hardcoded tool names | Replace with: current local Codex delegates after a direct request or applicable project/skill instruction; use the tools actually exposed by the chosen integration. | [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), **Availability**, **Approvals and sandbox controls**. Subagents consume extra tokens and inherit parent sandbox/permissions. Ultra availability is model/client-specific. Neither enabled feature nor catalog label authorizes a new team. CLI help does not prove `spawn_agent` / `wait_agent` tool names in every consumer. |
| Codex `apply_patch`, `rg`, end-to-end completion | These can remain application workflow preferences where the tools exist and the request calls for implementation; they are not model-specific capability findings. | Existing `harnesses.ts` plus local CLI help: no local run evaluated their effect. Retire universal “in this turn” language where background work, blockers or explicit assessment-only scope require a different stopping condition. |
| `records.ts` current-model discrepancy and learnings | Amend present-tense “current” wording to include the new Sol and date the catalog observation. Preserve historical checks. Keep platform learnings empty. | Fetched model pages and local catalog observations above. The “GPT-6 Pro” discrepancy should describe a ChatGPT mode and an unestablished API ID, not claim an exhaustive API absence check. No platform trial was run; quality, served identity and costs remain unmeasured. |

## Finite follow-up

The documentation changes can ship from this audit without a paid run. For any
later authorized behavioral experiment, compare one conditional prompt change
against the unchanged prompt on the same tasks, acceptance criteria, model and
provider route, harness/CLI, AgentProfile revision, reasoning settings, tools,
skills and environment. Record outcomes and resource use; leave unavailable
identity or cost unknown. A material configuration change reopens applicability,
not a presumption that the earlier pattern still helps.

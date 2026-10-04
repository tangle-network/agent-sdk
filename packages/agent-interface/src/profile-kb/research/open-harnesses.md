# Open harnesses and model APIs: source audit

Checked **2026-10-04 UTC** (2026-10-03 in Los Angeles), against `models.ts` and `harnesses.ts` at SDK commit `d94968288c6bc87e3077f75a1799bb90101ab9fd`. Every source below was read on that date. This is documentation/source inspection; no model, paid API, router, or installed-CLI executions were performed.

**Contract** means documented interface or inspected implementation. **Recommendation** means vendor/maintainer advice, without a measured local benefit. **Reported experiment** means the author's historical result under its stated conditions. None establishes comparative quality on the user's workload.

## Pi

- **Contract — launch and prompts.** `pi -p <prompt> --model <provider/id[:thinking]> --mode json` is supported. JSON mode emits JSONL and exits after supplied prompts; RPC mode stays alive on stdin/stdout. `--system-prompt` replaces the default; `--append-system-prompt` appends. `--model` also permits fuzzy matching, so an accepted argument alone does not identify the selected model. `--thinking` accepts `off|minimal|low|medium|high|xhigh|max` but clamps to model capabilities. Scope: pinned upstream CLI, not proof that every provider honors every level. [CLI, “Invocation and output”, “Models”, “Prompts and process”][p-cli]
- **Contract — control and completion.** RPC supports steering, follow-ups, model changes, compaction, and forks. Steering is delivered after the current assistant turn's tool calls, before the next model call; follow-ups wait until tool calls and steering are exhausted. `get_available_thinking_levels` exposes the selected model's supported levels. Scope: the native protocol, not a promise that a model follows steering correctly. [RPC Commands, `steer`, `follow_up`, `get_available_thinking_levels`][p-commands]
- **Contract — settlement.** A successful prompt response means accepted/queued/handled, not completed. `agent_end` can precede retries or follow-up work; consumers that need automatic work to finish wait for `agent_settled`, except when prompt disposition says `handled` and no run began. Scope: current RPC lifecycle; this is stronger operational guidance than “expect steering messages.” [RPC Mode, “Run lifecycle”][p-rpc]
- **Capability, not a default workflow.** Pi's README explicitly omits built-in subagents and plan mode; extensions/packages can supply them. The KB's unconditional instruction to launch several nested Pi processes is not a built-in capability contract or a measured recommendation. [Coding-agent README, introduction][p-readme]

## OpenCode

- **Contract — launch.** `opencode run <message> -m <provider/model> --agent <name> --variant <variant> --format json` is supported; variants are provider-specific. `serve` exposes the HTTP API, `run --attach` reuses a running server, and `acp` exposes an IDE protocol. Scope: available integration surfaces, not proof that a particular parent adapter supports every operation. [CLI, “run”, “serve”, “acp”][o-cli]
- **Contract — prompt composition correction.** `instructions` files combine with discovered `AGENTS.md` rules. But the KB's “built-in prompt stays in place” is too broad: inspected `LLMRequestPrep.prepare` chooses `agent.prompt` **instead of** the provider prompt when present, then appends system/user additions; plugins can transform this further. [Rules, “Custom Instructions”][o-rules]; [source, `prepare`, lines 51–70][o-request]
- **Capability — delegation.** Named primary agents/subagents can have distinct prompts, models, and permissions. `permission.task` controls which subagents a parent may invoke. This supports a conditional instruction to use an available configured agent; it does not establish that a persona predicts competence or that delegation improves every task. [Agents, “Types”, “Model”, “Task permissions”][o-agents]
- **Disposition.** Remove the unconditional “use mounted MCP tools for external actions” from harness-specific advice unless the profile actually mounts them and requires that route. The listed CLI source establishes no advantage over other available external-action interfaces.

## Kimi Code CLI

- **Contract — headless invocation.** `kimi -p <prompt> -m <configured-alias> --output-format stream-json` is supported. Print mode already uses auto permission policy while retaining static deny rules; `--prompt` rejects combination with `--auto`, `--yolo`, or `--plan`. `--auto` and `--plan` are separate interactive/startup controls. `--agent-file` selects a new session's custom agent and cannot combine with resume/continue. Scope: current CLI interface, not generic permission advice. [kimi Command, “Main Command Options”, “Flag Conflict Rules”, “Non-Interactive Execution”][k-cli]
- **Contract — alias and effort.** The documented `kimi-code/k3` configuration alias points to model `k3` at the managed coding provider; it is not the public Moonshot API ID `kimi-k3`. Settings live in `~/.kimi-code/config.toml` or `$KIMI_CODE_HOME/config.toml`. `[thinking].effort` is model-dependent and falls back to the model default when unsupported; the documented K3 entry supports `low|high|max`. Scope: do not describe that trio as the harness-wide effort vocabulary. [Configuration files, “Config file location”, “Complete example”, “thinking”][k-config]
- **Capability — subagents.** Built-ins include `coder`, read-only `explore`, and `plan` without shell access. Their contexts are isolated by default, and each consumes tokens independently. The docs advise avoiding delegation for simple tasks. Scope: built-in default behavior; optional/custom configurations can alter delegation. This is more specific than the KB's generic “plan first, edit and verify each step,” for which no Kimi-specific efficacy evidence was found. [Agents and Sub-Agents, “Built-in Sub-Agents”, “Context Isolation and Resource Cost”][k-agents]

## Moonshot Kimi K3

- **Contract.** Public API ID `kimi-k3`; 1M context and native vision. Thinking is always enabled; top-level `reasoning_effort` accepts `low|high|max`, default `max`. Fixed sampling fields should be omitted (`temperature=1`, `top_p=.95`, plus fixed penalties/count). Complete assistant messages must be replayed unchanged, including reasoning and tool calls. Vision content must be structured and uses base64 or uploaded-file references rather than public image URLs. Scope: Moonshot API, not router or CLI translation. [K3 quickstart, “Reasoning effort”, “Vision input”, “Important limits”][m-k3]; [Reasoning Effort, “Fields”][m-effort]
- **Recommendation — large tool catalogs only.** For dozens/hundreds of tools, Moonshot recommends a small core set plus tool search, followed by dynamic declarations. When retrieval is a required workflow step, force the first tool turn and then restore automatic choice. The backend must implement search; declarations are request-local and should be carried forward when still needed. Scope: K3's API extension, not a universal prompting rule or a measured result here. [Tool Calling Best Practices, “Declare a search tool”, “Use tool_choice”, “Inject tool definitions”][m-tools]
- **Contract — dynamic loading boundary.** A dynamic declaration is a `system` message with `tools` and no `content`; the documented feature currently supports only K3. Appending declarations preserves the earlier cache prefix; editing earlier history can invalidate the suffix. Scope: compatible API/client support must be established before emitting such messages. [Dynamically Loaded Tools, “Impact on context caching”, “Notes”][m-dynamic]
- **Disposition.** Keep the KB's history/sampling constraints as operator facts. Remove generic repository navigation/test-loop text from model-specific prompt advice. `ultracode` is not a documented K3 effort; any project alias needs an independently sourced adapter mapping.

## DeepSeek V4.1 Flash

- **Contract.** Vendor API ID `deepseek-flash` currently denotes V4.1-Flash, with 1M context, 384K maximum output, vision, tools, and optional non-thinking mode. `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are compatibility names for retired models now served by V4.1-Flash. Scope: vendor API; the KB's namespaced router ID remains a separate historical observation. [Models & Pricing, “Model Details”, footnote 1][d-models]
- **Contract — reasoning and replay.** Thinking defaults on at `high`. Documented mappings include `minimal→low`, `medium/xhigh→high`, and `ultra→max`; `low|high|max` are native levels. With `tools`, preserve all previous `reasoning_content`, including turns without tool calls; without tools it is ignored. In thinking mode, temperature and frequency/presence penalties have no effect. Scope: DeepSeek protocols, not normalized SDK effort names. [Thinking Mode, “Thinking Mode Toggle and Effort Control”, “Input and Output Parameters”, “Tool Calls”][d-thinking] (read through direct HTTP after browser-tool timeouts).
- **Integration evidence with documentation drift.** Official OpenCode integration exists; its dedicated page recommends ≥1.18.30 but still labels the selection “V4-Flash.” The older combined guide recommends ≥1.14.24 and labels it V4.1-Flash. Prefer the model/pricing page for identity and verify the actual harness catalog when configuring. Neither establishes a quality advantage or requires OpenCode. [Dedicated guide][d-open]; [combined guide, “Integrate with OpenCode”][d-agents]
- **Disposition.** Replace “official partner harness” with the narrower integration fact. Drop generic “state the goal/use tools/check work” from model-specific prompt advice. Do not transfer older DeepSeek-R1 prompting recommendations to V4.1 without fresh evidence.

## Z.ai GLM-5.3

- **Contract.** `glm-5.3` is text-only, with 1M context and 128K maximum output. Thinking cannot be disabled. The direct API accepts only `low|high|max`, default `max`. **Recommendation:** Z.ai recommends `max` for complex coding; this is vendor guidance, not a local effort sweep. [GLM-5.3, “Feature Changes”][z-model]
- **Contract — surface-specific mapping.** Coding Plan maps `none|minimal|low→low`, `medium|high→high`, and `xhigh|max→max`; direct GLM-5.3 API requests reject other levels. Scope: Coding Plan mapping must not be attributed to all API/router surfaces. Generic advice elsewhere on the same page about disabling thinking does not apply to 5.3. [Deep Thinking, “Core Parameters”][z-thinking]
- **Disposition.** Keep the API restrictions and label “max for coding” as recommendation. Remove generic “work through to a verified result” from model-specific prompting. `ultracode` is not in the documented API/plan effort lists; namespaced aliases and their translation remain adapter/router claims.

## Version and evidence boundaries

| Harness | KB's 2026-09-22 observation | Upstream release found on this check |
| --- | --- | --- |
| Pi | 0.87.1 | [1.0.2, published 2026-10-04 UTC][p-release] |
| OpenCode | 1.18.32 | [1.18.34, published 2026-09-30][o-release] |
| Kimi Code | 2.0.2 | [2.1.1, published 2026-09-24][k-release] |

These establish upstream freshness, not installation or compatibility on the deployment host. Pi source was pinned at `200387122ca450d6387f033949423114a270b96c`; OpenCode at `907b3bc518fa48e90e8ec24dd327d13eee71c36c`. Preserve old successful router/CLI checks with their original date; documentation does not refresh them. A successful old HTTP response proves that request was accepted then, not current service identity or workload quality.

## Maintainer engineering evidence worth retaining narrowly

- **Reported experiment / opinion, 2025-11-30:** Pi's creator describes a small prompt/tool surface and optional shell-spawned review agents. The Terminal-Bench comparison used Pi with Opus 4.5 against other harnesses with their respective models, so it does not isolate prompt length, delegation, or harness effects. Treat minimalism and review delegation as hypotheses, not universal prescriptions. The post's historical “no MCP” claim is superseded by current Pi CLI documentation. [“Minimal system prompt”, “No sub-agents”, “Benchmarks”][e-pi]
- **Reported experiment, 2025-08-15:** 120 Claude Code runs crossed three terminal tasks, four interfaces, and ten repetitions. Terminalcp's MCP and CLI variants both reached reported 100% success; time/cost varied by task and interface. The author used model judging and continuation nudges. This is useful evidence that interface details matter, not that MCP or CLI always wins, nor a result on current frontier models. [“Task definitions”, “Running the evaluation”, “Statistics and judgments”, “The Results”][e-mcp]

[p-cli]: https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/docs/cli.md
[p-commands]: https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/docs/rpc-commands.md
[p-rpc]: https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/docs/rpc.md#run-lifecycle
[p-readme]: https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/README.md
[p-release]: https://github.com/earendil-works/pi/releases/tag/v1.0.2
[o-cli]: https://opencode.ai/docs/cli/
[o-rules]: https://opencode.ai/docs/rules/#custom-instructions
[o-request]: https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/llm/request.ts#L51-L70
[o-agents]: https://opencode.ai/docs/agents/
[o-release]: https://github.com/anomalyco/opencode/releases/tag/v1.18.34
[k-cli]: https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html
[k-config]: https://moonshotai.github.io/kimi-code/en/configuration/config-files.html
[k-agents]: https://moonshotai.github.io/kimi-code/en/customization/agents.html
[k-release]: https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai/kimi-code%402.1.1
[m-k3]: https://platform.kimi.ai/docs/guide/kimi-k3-quickstart
[m-effort]: https://platform.kimi.ai/docs/guide/use-reasoning-effort#fields
[m-tools]: https://platform.kimi.ai/docs/guide/kimi-k3-tool-calling-best-practice
[m-dynamic]: https://platform.kimi.ai/docs/guide/use-dynamic-tool-loading
[d-models]: https://api-docs.deepseek.com/quick_start/pricing/#model-details
[d-thinking]: https://api-docs.deepseek.com/guides/thinking_mode/
[d-open]: https://api-docs.deepseek.com/quick_start/agent_integrations/opencode/
[d-agents]: https://api-docs.deepseek.com/guides/coding_agents/#integrate-with-opencode
[z-model]: https://docs.z.ai/guides/llm/glm-5.3#feature-changes
[z-thinking]: https://docs.z.ai/guides/capabilities/thinking#core-parameters
[e-pi]: https://mariozechner.at/posts/2025-11-30-pi-coding-agent/
[e-mcp]: https://mariozechner.at/posts/2025-08-15-mcp-vs-cli/

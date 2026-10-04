# KB distillation and consumer review

Checked 2026-10-04 UTC. This review is research and design feedback, not a platform learning or a claim that a revised prompt improves task outcomes. No model runs were purchased. SDK baseline: `d94968288c6bc87e3077f75a1799bb90101ab9fd`.

## Recommended change

Keep one canonical record per claim and derive the existing `prompt` and `operator` arrays. Each claim needs its text, audience, evidence kind, source references with a useful section/locator, and applicability. Source authority and claim kind are separate: vendor advice can be optional, and a practitioner's observation can be accurate without being universal. Conditions essential to safe interpretation belong in the rendered text, even when also recorded as metadata.

The change fixes entry-level citations that cannot show which source supports which sentence. It keeps composition small and leaves findings inspectable without injecting every finding. Cost: content migration and consumer-fixture updates; risk: losing a useful exception during compression. Rollback is the previous package version; old experiment profiles and receipts remain historical evidence. No new scheduler, routing policy, model ban, token cap, or general evidence framework is needed.

At baseline, delegation appears in both Claude Code and Opus guidance; planning, progress updates, completion checks, and broad exploration recur across model entries. These are candidates for editorial consolidation, not proof that shorter prompts perform better. Retain distinctive controls and failure-preventing conditions. Do not make a generic checklist or an instruction to explore unnamed files model-specific merely because a vendor example contains it. Operator-controlled settings belong in operator guidance. Keep hypotheses outside automatic injection, and allow an entry to contribute no prompt text when there is no supported model-specific instruction.

## Compatibility and consumers

The existing [composition implementation](../index.ts), [types](../types.ts), and [tests](../profile-kb.test.ts) establish these requirements:

- Preserve exported lookup/composition names and legacy array shapes. Public records are mutable by type; composition intentionally uses frozen load-time snapshots.
- Preserve exact-version lookup, aliases, route-prefix and suffix handling, unknown-name no-op behavior, and duplicate-alias rejection.
- Preserve deterministic ordering, idempotence, executor overrides, and canonical profile identity. A changed KB release can change a composed digest; repeating composition within a release must not.
- Replace only KB-owned `harness`, `model`, and `learning` blocks, keep caller-owned layers and literal marker examples, and keep the profile's own text last.
- Preserve harness-capability selection of `appendSystemPrompt` versus `instructions`. Never downgrade a request to replace a system prompt into an append operation.

Targeted searches inspected the four named repositories, not the workstation. The checked-out Runtime and Supervisor Lab branches were older than their local remote refs; the references below identify the actual evidence inspected. They establish code consumers, not installed or served versions.

| Consumer at inspected revision | Requirement and smallest proof |
| --- | --- |
| [Runtime supervise](https://github.com/tangle-network/agent-runtime/blob/9e91e40e6dcf1a6d074c04e4439fbf53396a9269/src/runtime/supervise/supervise.ts#L3019) | `profileGuidance: 'profile-kb'` is opt-in. Composition precedes root identity, spawn preflight, and execution; results must parse as `AgentProfile`. Run the scripted-root test in `tests/kernel/supervise-option-keys.test.ts` against the built candidate package. |
| [Runtime spawn](https://github.com/tangle-network/agent-runtime/blob/9e91e40e6dcf1a6d074c04e4439fbf53396a9269/tests/kernel/coordination.test.ts#L254) and [graph](https://github.com/tangle-network/agent-runtime/blob/9e91e40e6dcf1a6d074c04e4439fbf53396a9269/tests/kernel/graph.test.ts#L315) | Preflight and worker must receive the same composed profile. Pinned graph nodes, including analysts, must receive guidance without losing role text or delegate instructions. Existing deterministic seams need no paid model. |
| [Supervisor Lab `baseProfile`](https://github.com/tangle-network/supervisor-lab/blob/77817fbfcb8b184e6550af101006889bfb1b0422/src/learn/run.ts#L75) | Guidance stays outside the searched `systemPrompt`; run `src/learn/profile-kb.test.ts` against the candidate package to prove channel selection and recomposition. |
| Discovery Lab `45c883e596882c381cfaafcdc62cb228e50db048`; CLI Bridge `94eb815f0e8df87b4635818d7e24dea2cfe71fdb` | No direct KB import or `profileGuidance` match in the inspected active source/docs/package paths. They may consume composed profiles transitively; absence here is not evidence of zero runtime usage. |

Runtime fixtures currently expect model blocks for `deepseek-v4.1-flash` and `claude-opus-5-5`; Supervisor Lab expects `glm-5.3` and harness `opencode`. If source review removes unsupported guidance, select verified fixture models and preserve the behavioral assertions rather than retaining unsupported filler. In the SDK, the requirement that every entry have nonempty `prompt`, the exact catalog assertion, and the limit of five learnings are editorial policy, not compatibility evidence. Source support, alias uniqueness, composition, and ownership are the meaningful checks.

Minimum delivery proof is the SDK build/typecheck/affected tests plus the existing Runtime root, spawn, and pinned-node seams with the built candidate package resolved. Supervisor Lab's small profile test covers the second direct caller. This proves integration, not quality, latency, or cost improvement. This review identified those checks but did not run them.

## Practitioner signals and their limits

These are attributed hypotheses for investigation, not runtime mandates. Read against primary documentation or experiments before promoting any technique.

| Signal | Useful distillation | Conditions and primary follow-through |
| --- | --- | --- |
| Dex Horthy, [Advanced Context Engineering](https://www.humanlayer.dev/blog/advanced-context-engineering), 2025-08-29 | Preserve compact research findings, decisions, and next steps across long coding work. | The report involves engaged human review, includes a failed dependency-removal attempt, and says its workflow may not suit most teams. Its 40–60% utilization heuristic is not a universal bound. [Anthropic's context engineering article](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) supports preserving decisions and unresolved bugs while warning that aggressive compaction loses critical details. |
| Kyle, [Writing a good CLAUDE.md](https://www.humanlayer.dev/blog/writing-a-good-claude-md), 2025-11-25 | Keep persistent instructions relevant; point to task-specific material when needed. | The author's line-count guidance is a heuristic, not a provider requirement. Preserve necessary constraints and unusual tooling. The primary context-file experiments below support evaluating actual content, not imposing an arbitrary size limit. |
| Walden Yan, [Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents), and [2026-04-22 follow-up](https://cognition.com/blog/multi-agents-working) | Evaluate decision transfer and integration cost when parallelizing; clean-context review is a candidate technique. | The later report narrows the earlier position to workable review, consultation, and management patterns. Neither article establishes a universal topology rule. [Anthropic's research-system report](https://www.anthropic.com/engineering/multi-agent-research-system) describes gains on independent breadth-first research, increased token use, and difficulties with shared context and dependencies. Do not transfer its research gains to coding without measurement. |
| Yichao Ji, [Lessons from Building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus), 2025-07-18 | Keep recoverable pointers when compressing evidence; inspect prompt-prefix stability when cache efficiency matters. | Manus describes its own local design choices. Exact matching and invalidation should follow the selected provider's [prompt-caching contract](https://platform.claude.com/docs/en/build-with-claude/prompt-caching). Cache control and history serialization belong to the harness/provider owner, not a universal instruction injected into the model. A pointer is useful only while the referenced evidence remains accessible. |
| Hamel Husain, [Context Rot discussion notes](https://hamel.dev/notes/llm/rag/p6-context_rot.html), summarizing Kelly Hong | Treat context quality as task-dependent; preserve relevant evidence while removing repetitive observations. | Follow the [Chroma report](https://www.trychroma.com/research/context-rot) and [replication repository](https://github.com/chroma-core/context-rot) for the experiments. Needle retrieval, LongMemEval, and repeated-word tests do not establish a coding-harness compaction threshold or a universal model ranking. |

One concrete harness exception matters: current [Claude Code subagent docs, “What loads at startup” and “Fork vs non-fork”](https://code.claude.com/docs/en/sub-agents#what-loads-at-startup) distinguish fresh-context subagents from forks that inherit conversation history. Thus “subagents always start clean” would be a bad compression. Delegation guidance should preserve which context is transferred and whether the session actually exposes the capability.

## Evidence that should change the next decision

The primary [Gloaguen et al. context-file study, v1, §§4.2–5](https://arxiv.org/html/2602.11988v1) found generated files often increased cost with small performance declines, while human files produced modest gains for most tested agents. Its documentation-removal ablation changed the result. The study focuses on Python issue resolution; it does not establish that required project instructions or all guidance should disappear.

The primary [Lulla et al. efficiency study, v1, §§3–5](https://arxiv.org/html/2601.20404v1) reports lower runtime/output-token use across 124 PR tasks from 10 repositories. It explicitly excludes a full correctness evaluation and performs only a manual output sanity check. Its efficiency result cannot settle quality claims from a different study.

For this KB, evaluate a concrete removed or conditionalized instruction only when a value claim is required: same task, harness, model, resources, and outcome checker; compare the original and distilled compositions. Record task correctness, preserved constraints, coordination work, and total measured resources. Keep integration proof separate from that result. More confident prose, a shorter prompt, or a successful import is not evidence that the agent works better.

## Candidate review

An independent review on 2026-10-04 inspected the candidate `types.ts`, `entry.ts`, `index.ts`, model/harness records, tests, README, and retained research. No blocking composition or attribution issue was found. The pure composer still preserves source ownership, channel selection, overrides, unknown selections, and snapshot isolation; canonical claims retain provenance while hypotheses stay out of projected instructions. The two retained agent claims were checked directly against the primary [Opus visual-input section](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5#tools-for-complex-visual-inputs) and [Claude Code subagent context documentation](https://code.claude.com/docs/en/sub-agents#what-loads-at-startup).

This was a source review, not executed verification. It identified consumer fixtures requiring migration when empty guidance becomes legitimate. Runtime's root fixture can use Opus model guidance; its analyst-node fixture can preserve OpenCode while selecting Opus and checking model guidance. Supervisor Lab can use Claude Code/Opus for the composed-layer fixture and Opus for the router-channel fixture. These changes preserve each test's behavior without restoring unsupported prompt text. Release and Beelink verification are owned by the integrating task.

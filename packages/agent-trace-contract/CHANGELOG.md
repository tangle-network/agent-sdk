# @tangle-network/agent-trace-contract

## 2.0.0

### Major Changes

- 3a7eddb: Remove `ATTR.sideEffect`, `SideEffect` and `SIDE_EFFECTS`. Review finding: this package declared two representations of tool retry-safety — `agent.operation.side_effect`/`idempotency_key` attributes (this package) and agent-eval's contract-declared `writes[].idempotencyKey` (the one `retrySafe` actually reads and real traces prove). Verified against every repo in the org: no producer ever writes `agent.operation.side_effect`, and no reader ever checks it — it is genuinely dead vocabulary, unlike `operationId`/`attemptId`/`idempotencyKey`, which agent-runtime's supervise re-spawn producer does emit (a different concept: retrying a supervised agent node, not a tool call) and which stay. A consumer reading `ATTR.sideEffect` or the `SideEffect` type must drop that read; none exist in this org's repos today.

## 1.3.0

### Minor Changes

- 2c120a7: Export `isModelCallKind`/`MODEL_CALL_SPAN_KINDS`. `LLM`, `EMBEDDING` and `RERANKER` are each a separately billed leaf call to a model; the rest of `SpanKind` (`AGENT`, `CHAIN`, `TOOL`, `RETRIEVER`, `GUARDRAIL`, `EVALUATOR`, `PROMPT`) are aggregates whose own token/cost totals only restate a descendant's. A consumer that classified only `LLM` as a model call (agent-eval's `execution-measurements`) dropped an `EMBEDDING` or `RERANKER` span's tokens whenever a chat call anywhere in the same run also reported tokens.

## 1.2.0

### Minor Changes

- d132736: Classify spans by `gen_ai.operation.name` before model and token attributes, pinned to OTel GenAI semconv 1.41.0: `invoke_agent` is AGENT, `invoke_workflow` is CHAIN, `execute_tool` is TOOL, `retrieval` is RETRIEVER, and only `chat`, `generate_content` and `text_completion` are LLM. Token counts alone no longer make an undeclared span `LLM`; it needs a model attribute or an LLM-looking name. An agent or workflow span no longer counts its children's tokens a second time. `classifySpan` and `GEN_AI_OPERATION_MAPPINGS` publish what each mapping loses, and the validator reports it as `gen-ai-operation-loss`.
  
  `SpanKind` is now the full OpenInference vocabulary (adds `EMBEDDING`, `RERANKER`, `GUARDRAIL`, `PROMPT`), so `embeddings` maps without loss and a declared OpenInference kind is never reported as unknown. An OTLP span kind in a row's `kind` field (`SPAN_KIND_INTERNAL`) no longer hides its `openinference.span.kind` attribute.
  
  Add `agent.parent.confidence` (explicit, correlated, heuristic, unknown) with a `parentLinks` breakdown and a `heuristic-parent` finding, and the retry-safety attributes `agent.operation.id`, `agent.operation.attempt_id`, `agent.operation.idempotency_key` and `agent.operation.side_effect` (read, write). The contract now owns the cache-read, cache-write and reasoning token reader lists.
  
  `@tangle-network/agent-core/telemetry` takes its GenAI keys and reader lists from the contract; its model and token reader lists now accept every spelling the contract accepts.

### Patch Changes

- 298a5bc: `INPUT_TOKEN_ATTR_KEYS` and `OUTPUT_TOKEN_ATTR_KEYS` now accept the bare `input_tokens`/`output_tokens` keys, lowest priority, last in each list. Claude Code's native OTel capture (`claude_code.llm_request`) writes only these bare keys; the cache-read and cache-write lists already accepted their bare equivalents, but a Claude Code native trace read 0 input and 0 output tokens with non-zero cache counts. Safe now that token counts alone never decide a span's kind (see the token-counts-are-not-a-kind changeset).

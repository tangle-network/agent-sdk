---
"@tangle-network/agent-trace-contract": minor
"@tangle-network/agent-core": minor
---

Classify spans by `gen_ai.operation.name` before model and token attributes, pinned to OTel GenAI semconv 1.41.0: `invoke_agent` is AGENT, `invoke_workflow` is CHAIN, `execute_tool` is TOOL, `retrieval` is RETRIEVER, and only `chat`, `generate_content` and `text_completion` are LLM. Token counts alone no longer make an undeclared span `LLM`; it needs a model attribute or an LLM-looking name. An agent or workflow span no longer counts its children's tokens a second time. `classifySpan` and `GEN_AI_OPERATION_MAPPINGS` publish what each mapping loses, and the validator reports it as `gen-ai-operation-loss`.

`SpanKind` is now the full OpenInference vocabulary (adds `EMBEDDING`, `RERANKER`, `GUARDRAIL`, `PROMPT`), so `embeddings` maps without loss and a declared OpenInference kind is never reported as unknown. An OTLP span kind in a row's `kind` field (`SPAN_KIND_INTERNAL`) no longer hides its `openinference.span.kind` attribute.

Add `agent.parent.confidence` (explicit, correlated, heuristic, unknown) with a `parentLinks` breakdown and a `heuristic-parent` finding, and the retry-safety attributes `agent.operation.id`, `agent.operation.attempt_id`, `agent.operation.idempotency_key` and `agent.operation.side_effect` (read, write). The contract now owns the cache-read, cache-write and reasoning token reader lists.

`@tangle-network/agent-core/telemetry` takes its GenAI keys and reader lists from the contract; its model and token reader lists now accept every spelling the contract accepts.

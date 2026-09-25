---
"@tangle-network/agent-trace-contract": minor
---

Export `isModelCallKind`/`MODEL_CALL_SPAN_KINDS`. `LLM`, `EMBEDDING` and `RERANKER` are each a separately billed leaf call to a model; the rest of `SpanKind` (`AGENT`, `CHAIN`, `TOOL`, `RETRIEVER`, `GUARDRAIL`, `EVALUATOR`, `PROMPT`) are aggregates whose own token/cost totals only restate a descendant's. A consumer that classified only `LLM` as a model call (agent-eval's `execution-measurements`) dropped an `EMBEDDING` or `RERANKER` span's tokens whenever a chat call anywhere in the same run also reported tokens.

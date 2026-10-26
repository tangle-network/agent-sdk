---
"@tangle-network/agent-trace-contract": minor
---

Add one wire-id rule and the OTLP JSON wire, so producers stop disagreeing.

- `toW3CTraceId(id)` / `toW3CSpanId(id)`: a valid W3C id passes through, a UUID passes through without its dashes, anything else goes through `deriveHexId`. The Sandbox SDK, agent-app, agent-eval and agent-runtime each had a different rule, so one readable run id could land under up to three trace ids.
- New leaf subpath `@tangle-network/agent-trace-contract/otlp`: `toOtlpAttributes`, `toOtlpAnyValue`, `msToUnixNano`, `otlpTraceExport`, `readOtlpPartialSuccess`, `decodeOtlpAttributes`, `decodeOtlpAnyValue`, `decodeOtlpTraceExport`, the `OtlpSpan` / `OtlpTraceExport` wire types and the `OTLP_SPAN_KIND` / `OTLP_STATUS_CODE` codes. It imports nothing but the id rule, so a Worker or a published SDK can take it.
- `ATTR.toolDefinitions` (`gen_ai.tool.definitions`), `ATTR.agentName` (`gen_ai.agent.name`) and `ATTR.conversationId` (`gen_ai.conversation.id`), which agent-runtime, agent-eval and traces each spelled locally.

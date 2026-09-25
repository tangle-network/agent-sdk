---
"@tangle-network/agent-trace-contract": major
---

Remove `ATTR.sideEffect`, `SideEffect` and `SIDE_EFFECTS`. Review finding: this package declared two representations of tool retry-safety — `agent.operation.side_effect`/`idempotency_key` attributes (this package) and agent-eval's contract-declared `writes[].idempotencyKey` (the one `retrySafe` actually reads and real traces prove). Verified against every repo in the org: no producer ever writes `agent.operation.side_effect`, and no reader ever checks it — it is genuinely dead vocabulary, unlike `operationId`/`attemptId`/`idempotencyKey`, which agent-runtime's supervise re-spawn producer does emit (a different concept: retrying a supervised agent node, not a tool call) and which stay. A consumer reading `ATTR.sideEffect` or the `SideEffect` type must drop that read; none exist in this org's repos today.

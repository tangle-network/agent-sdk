---
"@tangle-network/agent-interface": minor
"@tangle-network/agent-provider-tangle": patch
"@tangle-network/agent-provider-e2b": patch
"@tangle-network/agent-provider-daytona": patch
"@tangle-network/agent-provider-computesdk": patch
"@tangle-network/agent-provider-testkit": minor
---

Require materialization coverage for all model token ceilings and add explicit per-turn event usage aggregation semantics.
Tangle marks terminal usage totals as cumulative and preserves explicit usage modes.
Direct sandbox adapters reject unsupported keyed creation before provisioning instead of relying on process-local retry state.

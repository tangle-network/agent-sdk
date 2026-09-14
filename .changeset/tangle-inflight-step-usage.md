---
"@tangle-network/agent-provider-tangle": minor
---

Report an OpenCode execution's running token usage on each step frame, before the terminal receipt.
Sandbox forwards OpenCode's `step_finish` event with that step's counts, and the adapter now attaches the execution's cumulative total to it as `usage` with `usageMode: "cumulative"`.
A token reservation can therefore stop an execution while it runs; previously every event before the receipt carried no usage.
Only streams that start at the execution's first frame report a total, a repeated step counts once, and the terminal receipt is delivered unchanged.

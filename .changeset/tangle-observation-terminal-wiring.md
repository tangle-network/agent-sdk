---
"@tangle-network/agent-provider-tangle": minor
---

Wire the Tangle provider to the observation and interactive-terminal contracts.

`environment.observe()` returns the normalized observation over the Sandbox SDK: provider and session identity, lifecycle with its scheduled retirement, the credential-free runtime endpoint, verified placement, requested and effective compute shape, current and peak memory use, the newest execution's token usage and cost, GPU-lease compute billing, and the account plan, credits, quota, and billing period.
Each surface carries its freshness state, so a value Sandbox does not report is visibly absent instead of arriving as a measured zero.
Sandbox states no effective CPU or disk, no CPU utilization, and no per-sandbox container compute cost, so those surfaces report `unavailable` with the reason.

`environment.attachTerminal()` and `environment.terminal()` bind the sandbox terminal WebSocket: attach and reattach, ordered output with an exclusive replay cursor, input, resize, detach, and close, each bound to its parent execution and to a fail-closed expiry.

Both capability blocks are claimed only where a concrete source backs them, and the create call now sends the compute shape Sandbox reads (`cpuCores`, `memoryMB`, `diskGB`, `accelerator`) instead of passing the contract's field names through unchanged.

A transport failure never reaches a payload as its own message, because the Sandbox SDK states the request URL there and that URL can carry a credential.
Each degraded surface names the read that failed and a structured cause: an HTTP status, an error code, or an abort.
Each surface is also held to its own schema, so one value the contract refuses degrades that surface alone instead of destroying the observation beside it.
The observation subject names only the provider and the environment id, which both a create handle and a handle rebuilt by id can produce, so the two bind to each other.
A detached or dropped terminal socket makes its reference unusable, a reattach closes the socket it replaces, and the terminal states the replay cursors it can serve.

---
"@tangle-network/agent-interface": minor
---

`nativeReasoningControl` now matches the flags the pinned CLIs accept, so the sandbox sidecar, cli-bridge and agent-runtime can all read it instead of keeping their own effort maps. pi's `ultracode` sends `max` (pi 1.4.0 accepts `--thinking max`; it sent `xhigh`). openclaw gains its `--thinking` entry (`off` through `max`; it answered `null`). opencode takes an optional `model` argument and sends the model's ceiling for `ultracode`: `max` for GLM and `xhigh` otherwise (it sent `ultracode`, which every provider refuses).

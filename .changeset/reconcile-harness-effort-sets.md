---
"@tangle-network/agent-interface": minor
---

Reconcile per-harness reasoning-effort sets with the real cli-bridge adapters so the chat picker no
longer offers levels a harness can't actually run (gtm-agent#398):

- `codex` → `minimal·low·medium·high` (drop the inert `none`; xhigh/ultracode aren't accepted)
- `claude-code` → `low·medium·high·xhigh·ultracode` (its `--effort` ladder; `ultracode` stands in for
  the adapter's `max`; `none`/`minimal` dropped as redundant)
- `pi` / `openclaw` → cap at `xhigh`
- `kimi-code` → binary `minimal`/`high` (its `--thinking` on/off toggle), not five levels
- `acp` added to the ignore-effort set (its runner reads no `reasoningEffort`)

Adds an explicit `harnessReasoningEffortsOverride` for non-`none…ceiling` sets; `harnessReasoningEfforts`
prefers it over the ceiling slice.

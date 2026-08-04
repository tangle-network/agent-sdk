---
"@tangle-network/agent-interface": patch
---

Offer codex `none` and pi `ultracode` in the reasoning-effort sets.

Both were measured against the pinned CLI binaries and both were reachable all along: the codex API enumerates `none` first in its own error, and `pi --thinking` accepts `max`, which canonical `ultracode` maps to. The picker hid them, so turning thinking off on codex and reaching pi's top rung were not selectable.

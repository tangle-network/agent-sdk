---
"@tangle-network/agent-provider-tangle": patch
---

Workspace evidence capture no longer lists every directory below a credential directory. It records the directory as excluded and accounts for its subtree with one complete usage scan, so the inventory still reconciles with the workspace totals. On a served Sandbox workspace a capture fell from 288 list requests and 82–87 s to 13 list and 5 usage requests and 6–7 s, with identical totals.

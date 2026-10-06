---
"@tangle-network/agent-provider-testkit": patch
---

Workspace branching conformance takes `forks: "dependent" | "copies"`. With `copies`, deleting the checkpoint while a fork lives must succeed, the checkpoint must no longer be found, and the fork must stay recoverable unchanged. The default, `dependent`, keeps the existing rule: answer `in_use`, name the fork and delete nothing.

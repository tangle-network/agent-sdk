---
"@tangle-network/agent-provider-testkit": patch
---

Workspace branching conformance accepts a provider whose forks hold their own copy of the checkpoint: deleting the checkpoint while a fork lives may succeed, provided the fork stays recoverable. A provider with dependent forks still must answer `in_use`, name the fork and delete nothing.

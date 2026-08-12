---
"@tangle-network/agent-provider-tangle": minor
---

Derive Tangle capability claims from probed facts.

One narrowing core produces the capability document for the provider and for each sandbox.
The provider claims retainedControl only when a lazy probe of the linked SDK surface proves dispatchPrompt, session, and cancelRun, and the client exposes get for reconstruction; an unproven client fails closed before any sandbox is created.
SandboxClientLike documents an optional fetch member: retained control requires an SDK-backed client, and object-spread wrappers lose it.
Each sandbox narrows the declared document from its own measured facts, so a capable sandbox keeps retained control under a wrapper client.
Session status bound to an exact control reference reports unknown unless the payload names that execution; queued sessions map to pending.
Removed: the TanglePromptOptions export (use PromptOptions from @tangle-network/sandbox) and SandboxInstanceLike.checkpoint/fork with the unreachable environment checkpoint and fork methods.
Requires @tangle-network/sandbox >=0.19.6.

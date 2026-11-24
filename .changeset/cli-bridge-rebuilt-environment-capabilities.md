---
"@tangle-network/agent-provider-cli-bridge": patch
---

`get(id)` on the provider that created an environment asks the Bridge for the route's capabilities when `create` did not. It repeated the document `create` published, and a `create` that runs before `provider.capabilities()` has verified the route publishes no `retainedControl`. Runtime's `reconnectRetainedRun` and `startRetainedRunInEnvironment` read that document from the environment and refused it with "cannot control a retry-safe retained run", although the route passes discovery. A document `create` resolved from the Bridge is still reused without another request, so a reattached turn keeps its transport.

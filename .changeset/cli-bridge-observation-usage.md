---
"@tangle-network/agent-provider-cli-bridge": minor
---

Add the normalized environment observation to the cli-bridge provider.

`environment.observe()` reports provider identity, lifecycle, the credential-free bridge endpoint, verified placement, and the token usage and cost of the newest execution the handle measured.
The usage of one run is summed across its events and attributed to that run's execution id.
cli-bridge provisions no compute and holds no account, so the compute shape, resource use, compute cost, and account surfaces are never claimed and always carry `unavailable` with the reason.
The observation surface is offered only where the provider document claims it, and the endpoint claim is cleared when the base URL states no reachable host.

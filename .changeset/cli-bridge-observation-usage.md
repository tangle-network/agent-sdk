---
"@tangle-network/agent-provider-cli-bridge": minor
---

Add the normalized environment observation to the cli-bridge provider.

`environment.observe()` reports provider identity, the credential-free bridge endpoint, and the token usage and cost of the newest execution the handle measured.
cli-bridge never probes the bridge, so the configured execution kind is carried as the requested placement, and the verified placement and the lifecycle of a live handle state `unavailable` with that reason.
A destroyed handle reports a stopped lifecycle, because the adapter performed the destroy.
The usage of one run is summed across its events and attributed to that run's execution id.
cli-bridge provisions no compute and holds no account, so the compute shape, resource use, compute cost, and account surfaces are never claimed and always carry `unavailable` with the reason.
The observation surface is offered only where the provider document claims it, and the endpoint claim is cleared when the base URL states no reachable host.

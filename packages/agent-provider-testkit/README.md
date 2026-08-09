# @tangle-network/agent-provider-testkit

Framework-neutral checks for packages that implement `AgentEnvironmentProvider`.

```ts
import {
  runAgentEnvironmentProviderConformance,
  runAgentExactProcessProviderLifecycleChecks,
  runInteractionResponseConformance,
  runPortableContextConformance,
  runSessionReplayConformance,
  runWorkspaceBranchingConformance,
} from '@tangle-network/agent-provider-testkit'

await runAgentEnvironmentProviderConformance({
  name: 'my-provider',
  createProvider: () => createMyProvider(),
})
```

The checks create an environment, stream one turn, verify terminal completion,
exercise declared workspace methods, and destroy the environment.

`runSessionReplayConformance()` dispatches a detached turn, rejects a competing run reference, requires stable event identifiers, replays after a cursor, and repeats the replay through a reconstructed session client.

`runInteractionResponseConformance()` starts from one prepared pending interaction plus prepared expired, cancelled, and transport-failure cases.
It proves all ten acknowledgement outcomes, wrong-run, wrong-environment, wrong-session, and wrong-interaction rejection, invalid-answer rejection, exact operation replay, same-response resolution, and changed-response conflict.
Run it once against the environment response method and once against the retained session response method.

`runPortableContextConformance()` requires both a ready request and a distinct `rejectionRequest` with an intentionally impossible token budget.
It proves planning creates no run or session, results cannot cross request identities, a real over-limit response and digest mismatch dispatch nothing, and one accepted digest returns an exact fresh-session receipt.
It also proves transfer retry recovers that session, changed-input retry conflicts, a stale native boundary is rejected, a matching native boundary sends no copied history, and native retry creates no duplicate continuation.
The native operation binds the exact new turn digest, replays the original result and current control reference on retry, and rejects a changed turn under the same operation identifier without dispatch.

`runWorkspaceBranchingConformance()` proves checkpoint and fork retries return the original resources, lookup recovers both results, changed-input key reuse conflicts, checkpoint deletion reports dependent forks without deleting either resource, and repeated ordered cleanup confirms the resources are absent.
If any later assertion fails after a resource is created, the check cleans up only references first proven to match the original request, recovers lost responses through exact lookup, and reports cleanup failures alongside the original failure.

The base provider check strictly validates capabilities, requires disabled optional operations to be absent, requires native continuation claims to expose both session operations, rejects partial durable-branch declarations, and destroys created environments even when a check fails.
If both the check and environment destruction fail, it reports both errors.

`runAgentExactProcessProviderLifecycleChecks()` checks idempotent create and collision rejection, bounded exact-byte file round trips, terminal reasons, output replay, recovery, lookup, and deletion.
It intentionally does not certify a provider's network isolation, secret handling, public exposure, or process-tree behavior; provider packages must prove those properties against their real infrastructure.

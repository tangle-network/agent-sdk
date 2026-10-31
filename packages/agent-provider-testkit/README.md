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

The checks create an environment, prove it is ready, stream one turn, repeat a keyed create with reordered fields, reject changed keyed input, verify terminal completion, exercise declared workspace methods, and destroy the environment.

The base check also runs `runWorkspaceSnapshotConformance()`. A provider without `create.workspaceSnapshot` must explicitly refuse a valid snapshot request after adapter reconstruction. Standalone checks can supply `effectCount` to prove credentials, allocation and admission did not run. An advertised receiver requires `workspaceSnapshot: { request, verify }`; the fixture uses its authorized artifact store, and `verify` must compare restored workspace and Git state through the real receiver. The check destroys only the environment it created. A local fixture proves its tested path, not a deployed provider integration.

The readiness check reads the environment's status before any other call and requires `running`: `create()` must return an environment that can accept a turn.
It names the one right answer rather than the wrong ones, because a failed or stopped environment is no readier than a provisioning one.
The first turn then runs immediately after it, before any later call has had time to let a starting environment finish.
An environment that is still starting fails this check instead of failing an unrelated one later.

`runSessionReplayConformance()` dispatches a detached turn, rejects a competing run reference, requires stable event identifiers, replays after a cursor, and repeats the replay through a reconstructed session client.

`runInteractionResponseConformance()` starts from one prepared pending interaction plus prepared expired, cancelled, and transport-failure cases.
It proves all ten acknowledgement outcomes, wrong-run, wrong-environment, wrong-session, and wrong-interaction rejection, invalid-answer rejection, exact operation replay, same-response resolution, and changed-response conflict.
Run it once against the environment response method and once against the retained session response method.

`runPortableContextConformance()` requires both a ready request and a distinct `rejectionRequest` with an intentionally impossible token budget.
It proves planning creates no run or session, results cannot cross request identities, a real over-limit response and digest mismatch dispatch nothing, and one accepted digest returns an exact fresh-session receipt.
It also proves transfer retry recovers that session, changed-input retry conflicts, a stale native boundary is rejected, a matching native boundary sends no copied history, and native retry creates no duplicate continuation.
The native operation binds the exact new turn digest, replays the original result and current control reference on retry, and rejects a changed turn under the same operation identifier without dispatch.

`runWorkspaceBranchingConformance()` proves checkpoint and fork retries return the original resources, lookup recovers both results, changed-input key reuse conflicts, checkpoint deletion matches the declared fork model (`forks: "dependent"`, the default, reports the dependent fork and deletes neither resource; `forks: "copies"` deletes the checkpoint and leaves the fork recoverable unchanged), and repeated ordered cleanup confirms the resources are absent.
If any later assertion fails after a resource is created, the check cleans up only references first proven to match the original request, recovers lost responses through exact lookup, and reports cleanup failures alongside the original failure.

The base provider check strictly validates capabilities, requires disabled optional operations to be absent, requires native continuation claims to expose both session operations, rejects partial durable-branch declarations, and destroys created environments even when a check fails.
If both the check and environment destruction fail, it reports both errors.

`runAgentExactProcessProviderLifecycleChecks()` checks idempotent create and collision rejection, bounded exact-byte file round trips, terminal reasons, output replay, recovery, lookup, and deletion.
It intentionally does not certify a provider's network isolation, secret handling, public exposure, or process-tree behavior; provider packages must prove those properties against their real infrastructure.

Set `keyedCreate: "unsupported"` for providers that cannot retain keyed admission.
The conformance check then requires keyed rejection before testing an unkeyed environment.
The default still requires same-key replay and changed-input refusal.
Provider tests must also prove rejection occurs before remote effects.

## Live profile conformance

`runLiveProfileConformance()` runs the requirements of [SPEC.md](SPEC.md) against a real provider with a real profile: a harness, a model, a system prompt, an MCP server, a hook, a denied tool, a subagent and mounted files, each carrying a nonce only that axis can reveal.
It reports every one of the 67 requirement ids as `pass`, `fail`, `skip` or `unproven`, with the observation behind each.
`unproven` names the probe this seam lacks (for example CAP-3 needs one provider on two backends); it is never counted as a pass.

```ts
const report = await runLiveProfileConformance({
  name: 'my-provider',
  credentials: ['MY_VENDOR_API_KEY'],
  harness: 'claude-code',
  model: 'glm-5.3',
  createProvider: () => createMyProvider(),
})
console.log(formatLiveReport(report))
```

A missing credential skips the run with `no credential: <NAME>` on every requirement; it never reports a pass.
The probes spend real model tokens and create real sandboxes, so they run only when the credential is present.
Each environment carries a run tag in its metadata. The suite lists the vendor side with that tag after teardown and fails on any survivor, then destroys it.
Pass `secretValues` (for example the Router key the adapter was given) so SEC-3 scans events, errors, metadata, workspace files and process command lines for them.
Keyed create is refused by the probes unless the provider claims `create.durableIdempotency`.
Pass `nativeAuth` to probe a turn that carries native CLI auth, the shape a Discovery root runs: `{ credentials, createProvider?, createInput?, turn? }` describes the exact create input and turn, and `credentials` names what the fixture needs.
The probe fails MOD-4 if that turn dies on a sidecar's refusal to prepare its profile (`Concurrent public profile materialization is disabled`), which a provider must treat as "launch without preparation".
Without the fixture, MOD-4 reports `unproven`, and a missing credential reports `no credential: <NAME>`.

The suite does not cover the optional tiers (OPT-1), the consumer path through `providerAsExecutor` (P11), a vendor-side lifetime read (TDN-4), or capacity propagation from an over-cap key (MOD-5); the report lists them as `unproven`.
The kit's own fake-backed tests were removed: a suite that agrees with a fake written beside it proves nothing about a provider.


# Agent provider spec: E2B, Daytona, ComputeSDK

What an `AgentEnvironmentProvider` must do for an `AgentProfile` to run as declared, and how each requirement is proven by a live run.
Phase 1 of 3: this spec; then one builder per provider; then a skeptic per provider.
Dated 2026-10-31.

## 0. How to read this

Normative words: MUST is required for the provider to carry a profile through `providerAsExecutor`. SHOULD is required unless the builder records why not. Tier `C` is core: every provider that accepts a profile. Tier `G` is gated: required only when the adapter claims the capability; an unclaimed capability MUST be absent from the capability document and the environment.

Citations name the repository, the pinned revision, and `path:line`. Pins:

| Short | Repository @ revision | Path prefix |
|---|---|---|
| `SDK:` | tangle-network/agent-sdk @ `e544750` | `packages/` |
| `RT:` | tangle-network/agent-runtime @ `30516b40` | `src/runtime/` |
| `EP:` | same | `src/runtime/environment-provider/` |
| `AC:` | tangle-network/agent-container @ `ee50ad82` | `packages/` |
| `CB:` | tangle-network/cli-bridge @ `263f700` | `src/` |
| `T:` | `SDK:agent-provider-tangle/src/` | |
| `E:` `D:` `C:` | `SDK:agent-provider-e2b/src/index.ts`, `-daytona/`, `-computesdk/` | |

Vendor SDK facts come from the published type definitions of `e2b@2.62.0`, `@daytonaio/sdk@0.227.0`, `computesdk@4.1.14`, read statically on 2026-10-31. They are marked "(SDK d.ts)" and are unproven until a live run confirms them.

Rate, price, quota, limit and version values are owned elsewhere and are not copied here. Read harness CLI versions from `AC:cli-agent-registry/src/harness-cli-versions.ts`, model wire and env names from `AC:cli-agent-registry/src/harness-contracts/contracts/<harness>.ts`, router defaults from `SDK:agent-interface/src/provider-config.ts:76-90`, ready timeouts from `T:tangle-readiness.ts` (`DEFAULT_TANGLE_READY_TIMEOUT_MS`).

## 1. Findings that shape the work

1. The consumer already hands the whole profile to the provider and records that the provider materialized it. `providerAsExecutor` calls `provider.create({...defaults, profile: createProfile, signal})` (`EP:provider-execution-source.ts:229-233`) and declares `materializer: 'environment-provider-create'`, with the model `known` when the profile names one (`EP:provider-materialization.ts:38-45`). None of E2B, Daytona or ComputeSDK reads `input.profile` (`E:55-64,146-155`, `D:64-79,218-229`, `C:66-74,193-207`), so the consumer's record is untrue for all three.
2. The consumer does not refuse a profile an adapter cannot run. Its only pre-create gate is `provider.validateProfile` (`RT:supervise/supervise-spawn-preflight.ts:59-80`), and none of the three implements it. The capability document's `profile.*` flags are not read by the executor path; they are read by the testkit (`SDK:agent-provider-testkit/src/conformance-helpers.ts:52-107`).
3. With no `turnCommand`, an adapter executes the turn's prompt text as a shell command in the sandbox: `command = turnCommand ?? providerOptions.command ?? providerOptions.agentCommand ?? input.prompt` (`SDK:agent-interface/src/environment-command-turn.ts:91-95`), and `providerAsExecutor` sets `prompt` to the task text (`EP:provider-turn-input.ts:138-140`). The base conformance check passes such a turn because it only requires a terminal event, not a completed one (`SDK:agent-provider-testkit/src/provider-conformance.ts:140-144`).
4. The Tangle provider does not materialize anything itself. It forwards `backend: {type, profile, model, runtimeAttachments, routing}` to the Sandbox platform (`T:tangle-create-options.ts:251-262`), whose sidecar owns CLI installation, config files, model wiring and usage receipts. A direct vendor sandbox has no such platform, so the adapter must supply that behavior. The reusable pieces already exist: `@tangle-network/agent-profile-materialize` (`AC:agent-profile-materialize/src/profile-materializer.ts:78`, a pure planner; cli-bridge pins it at `CB:package.json:37`), `@tangle-network/cli-agent-registry` (versions, model wire, env names, CLI probes per harness), and cli-bridge's backends (`CB:backends/claude.ts:549-550` spawns `claude -p ... --output-format stream-json` and parses it). A second parser or materializer is forbidden (one implementation per concept).
5. The shared materializer lowers files, prompt, tools, permissions, modes, mcp, hooks, subagents, skills, commands and resources. It does not read the model, harness, seats, proxySecrets, metadata or identity axes (`AC:agent-profile-materialize/src/profile-materializer.ts:78-221`; only `prime-profile.ts:404-405` reads the model). Model and credential wiring is the adapter's job, driven by `cli-agent-registry`.
6. Four SDK-shape defects exist today (SDK d.ts, unproven live): Daytona create takes `envVars`, not `env` (`D:224`; `CreateSandboxBaseParams`); ComputeSDK create takes `envs`, `directory`, `snapshotId`, `timeout`, not `env`, `cwd`, `snapshot`, `timeoutMs` (`C:201,199,182-185,146`); Daytona `fs.uploadFile(string, remotePath)` reads the first string as a local file path, so `D:183` cannot write text (the fallback at `D:252-257` swaps arguments and fails the same way); E2B `commands.run` throws `CommandExitError` on a non-zero exit instead of returning an exit code (`E:129-135`).
7. No credential for any of the three providers exists in the vault (section 5). No live proof can run until Drew supplies them.

## 2. Consumer contract (what agent-runtime does with a provider)

| Step | What the consumer does | Cite |
|---|---|---|
| Resolve | Provider or registry name resolved once at intake | `RT:supervise/executor-config.ts:122-165` (resolved once at `:152`) |
| Pre-flight | `validateProfile` errors refuse the spawn; MCP coordination needs `create.runtimeAttachments.mcp` | `RT:supervise/supervise-spawn-preflight.ts:59-80,127-133` |
| Create | Non-retained path unless `capabilities().retainedControl` is declared | `EP:provider-execution-source.ts:219-235` |
| Turn | `environment.stream(turn)`; turn input is schema-parsed first | `EP:provider-execution-source.ts:219-220,234` |
| Observe | Events become text, archive, failure ledger, trace steps, progress, usage | `EP:provider-turn-observer.ts:50-95` |
| Settle | Usage settled; a terminal event is required by default; validator runs with a live `box`; workspace captured through a caller port | `EP:provider-turn-settlement.ts:136-188` |
| Transcript | `environment.read` + GNU `find` over `$HOME/<harness roots>` | `RT:harness-transcript.ts:386-392,426-469` |
| Release | Environment destroyed after settle unless preserved; a failed destroy is rechecked with `get(id) === null` | `EP:provider-turn-settlement.ts:331-340`, `EP:provider-environment-teardown.ts:104-117` |
| Cancel | Without retained control the only cancellation is aborting the local signal; the environment stays for teardown | `EP:provider-executor-lifecycle.ts:167-181` |

Because exec-only adapters declare no `retainedControl` (`SDK:agent-interface/src/environment-command-turn.ts:153-168`), they run the non-retained branch. Optional tiers (retained control, steering sessions, interactions, branching) are in OPT-1.

## 3. Requirements

Columns: Tier; Evidence (consumer or Tangle behavior that derives the requirement); Proof (probe ids defined in section 4).

### CAP: capability honesty

| ID | Tier | Requirement | Evidence | Proof |
|---|---|---|---|---|
| CAP-1 | C | `AgentEnvironmentCapabilitiesSchema.parse(await provider.capabilities())` succeeds; a `create` block states at least one honored field. | `SDK:agent-interface/src/environment-runtime.ts:566-864,771-796`; `SDK:agent-provider-testkit/src/provider-conformance.ts:21-23` | P14 |
| CAP-2 | C | Every optional method is present if and only if its capability flag is true, for the provider document and each environment's document. | `SDK:agent-provider-testkit/src/conformance-helpers.ts:52-107` | P14 |
| CAP-3 | C | A fact decided by the backing deployment is published per environment in `environment.capabilities`, not in a static provider document. | `SDK:agent-interface/src/environment-runtime.ts:365-377` | P14 on two backends |
| CAP-4 | C | `profile.*` flags are true only for axes proven by MAT-7; false otherwise. `systemPrompt.replace/append` never exceeds `harnessSystemPromptIntents(harness)`. | `SDK:agent-interface/src/harness-capabilities.ts:611-616`; `T:tangle-capabilities.ts:45` | P3, P14 |
| CAP-5 | C | `validateProfile` exists, is side-effect free, and returns an `error` issue with `code` and `path` for every profile axis or harness the adapter cannot materialize. | `RT:supervise/supervise-spawn-preflight.ts:59-80`; `T:tangle-profile-validation.ts:31-40` | P13 |
| CAP-6 | C | `usage: true` only if every turn's terminal event carries usage. The consumer reads `event.usage` regardless of the flag. | `SDK:agent-provider-testkit/src/provider-conformance.ts:145-151`; `EP:provider-turn-observer.ts:72-74` | P5 |

### CRT: create, get, list, status

| ID | Tier | Requirement | Evidence | Proof |
|---|---|---|---|---|
| CRT-1 | C | `create` returns only an environment that is running and ready for the first turn, which includes harness installed, profile materialized and validated. The consumer adds no readiness wait. | `SDK:agent-interface/src/environment-runtime.ts:1110-1120`; `EP:provider-invocation.ts:36-41`; `SDK:agent-provider-testkit/src/provider-conformance.ts:66-72` | P1 |
| CRT-2 | C | Every create-input field the adapter does not honor is refused before any vendor call; none is accepted and dropped. The field table in 3.1 is the checklist. | `SDK:agent-interface/src/environment-runtime.ts:896-897`; `SDK:agent-interface/src/environment-requests.ts:42-45,108-113`; `T:tangle-create-options.ts:226-229,338-366` | P13 |
| CRT-3 | C | `creation` is `"created"` when this call provisioned the environment, absent when unprovable; the consumer never destroys an environment whose creation it cannot prove. | `SDK:agent-interface/src/environment-runtime.ts:329-341`; `RT:retained-run-start.ts:407-411` | P9 |
| CRT-4 | C | A keyed create (`idempotencyKey`) is rejected before provisioning unless durable idempotency is implemented and `create.durableIdempotency` is declared. | `SDK:agent-interface/src/environment-runtime.ts:1121-1124`; `SDK:agent-provider-testkit/src/provider-conformance.ts:35-52` | P13 |
| CRT-5 | C | `get(id, options)` returns `null` only for definitive absence, throws on transport or service failure, checks the returned id equals `id`, and rejects every option it does not honor (`readOnly`, `proxySecrets`, `proxySecretParents`, `expectedProxySecretGeneration`, `requireInPlace`, `contextTransfer`). | `SDK:agent-interface/src/environment-runtime.ts:1038-1059`; `EP:provider-environment-teardown.ts:109-117`; `T:tangle-provider.ts:463-472` | P9, P13 |
| CRT-6 | C | `list(query)` applies `query.name` and `query.metadata` and reports true status, or `list` is absent. | `SDK:agent-interface/src/environment-requests.ts:168-180`; `T:tangle-provider.ts` list | P9 |
| CRT-7 | C | `status()` reflects the vendor's current lifecycle state, and reports `expired` or `stopped` after destroy or expiry; it is never a constant. | `SDK:agent-provider-testkit/src/provider-conformance.ts:66-72` | P1, P9 |
| CRT-8 | C | `placement()` returns `kind: "provider"` with the vendor sandbox id and region where known, so spend and leaks are attributable. | `SDK:agent-interface/src/environment-requests.ts:211-218` | P1 |

#### 3.1 Create-input field table (CRT-2)

"Honor" means the vendor call carries it with the right SDK key; "refuse" means a typed refusal before any vendor call. A field the vendor cannot express MUST be refused.

| Field | Required behavior | E2B | Daytona | ComputeSDK |
|---|---|---|---|---|
| `profile` | MUST be read; inline profile required; see MAT-* | ignored | ignored | ignored |
| `backend` | harness selector; refuse a conflict with `profile.harness` | ignored | ignored | ignored |
| `requestedId` | refuse (vendors issue ids) | ignored | ignored | ignored |
| `runtimeAttachments` | refuse unless `create.runtimeAttachments.mcp` | refused `E:73` | refused `D:88` | refused `C:83` |
| `workspace.environment` | template or snapshot id | to `template` `E:147` | to `snapshot` `D:220` | `environment` key `C:195`, not an SDK key (SDK `templateId`/`snapshotId`) |
| `workspace.image` | image | ignored | to `image` `D:221` | to `image` `C:196` |
| `workspace.repoUrl`, `gitRef` | clone before create returns | ignored | `source` `D:222`, not a create param (SDK d.ts) | `repoUrl`,`gitRef` `C:197-198`, not SDK keys |
| `workspace.cwd` | repository-based cwd honored | ignored | ignored | `cwd` `C:199`, SDK key is `directory` |
| `workspace.checkpoint` | restore, or refuse | ignored | ignored | ignored |
| `workspace.snapshot` | refuse unless `create.workspaceSnapshot` | refused `E:70` | refused `D:85` | refused `C:80` |
| `workspace.providerOptions` | allowlist or refuse | ignored | ignored | ignored |
| `resources` | honor or refuse | ignored | raw `resources` `D:223` (image creates only; field names differ) | raw `resources` `C:200`, not an SDK field |
| `env` | exact | `envs` `E:151` | `env` `D:224`, SDK key `envVars` | `env` `C:201`, SDK key `envs` |
| `secrets`, `proxySecrets`, `proxySecretParents` | honor with vendor-native semantics, or refuse | ignored | ignored (SDK has `secrets`) | ignored |
| `egress` | honor the mode or fail the create; never weaken or widen | ignored (SDK `allowInternetAccess`, `network`) | ignored (SDK `networkBlockAll`, `networkAllowList`, `domainAllowList`) | ignored |
| `billingOwner` | refuse unless `create.billingOwner` | ignored | ignored | ignored |
| `metadata` | vendor tags (string values) | `E:152` | `labels` `D:225` | `C:202` |
| `name` | honor or tag | ignored | `D:226` | `C:203` |
| `idempotencyKey` | refuse unless durable | refused `E:76` | refused `D:91` | refused `C:86` |
| `signal` | threaded into the vendor create so an abort cancels it | pre-check only `E:69` | pre-check only `D:84` | pre-check only `C:79` (SDK accepts `signal`) |
| `providerOptions` | schema-checked allowlist; unknown keys refused | raw spread `E:153` | raw spread `D:227` | raw spread `C:205` |

### MAT: harness materialization

Materialization applies to every profile a provider accepts. A provider that materializes nothing MUST refuse every profile that names a harness, behavior, model, tool, mcp, hook or subagent (CAP-5, CRT-2).

| ID | Tier | Requirement | Evidence | Proof |
|---|---|---|---|---|
| MAT-1 | C | The harness is `profile.harness`, else `input.backend`; both present and different is refused; absent is refused. It MUST be in the adapter's declared set, a subset of `MATERIALIZER_HARNESSES` whose CLI the sandbox image carries. No default shell turn. | `T:tangle-create-options.ts:146-150,161-164`; `AC:agent-profile-materialize/src/harness.ts:1-12` | P1 |
| MAT-2 | C | Before the first turn the harness CLI is present at the owner's pinned version: the contract's `processProbe.versionCommand` exits 0 and prints the pinned version. The image (template, snapshot, image) is built from the owner's pins; installation or probe failure fails `create` and cleans up (TDN-3). | `AC:cli-agent-registry/src/harness-cli-versions.ts:1-18`; `AC:cli-agent-registry/src/harness-contracts/contract.ts:24-26`; `AC:.../contracts/claude-code.ts:8-12` | P1 |
| MAT-3 | C | The workspace plan comes from `materializeProfile(profile, harness, {binds, runtimeAttachments})`. No second planner. | `AC:agent-profile-materialize/src/profile-materializer.ts:78-90` | P2 |
| MAT-4 | C | A non-empty `plan.unsupported` throws before the first turn unless the profile sets `resources.failOnError === false`, in which case each entry is returned as a warning in the run evidence. | `AC:agent-profile-materialize/src/plan-support.ts:22-35`; `AC:.../profile-plan.ts:145` | P2, P13 |
| MAT-5 | C | The plan is applied inside the sandbox: each `plan.files` entry at its root (workspace or agent), path, mode and ownership; `plan.env` on the harness process only; `plan.flags` on its argv; `systemPrompt`, `appendSystemPrompt` and `systemPromptBinding` bound to the harness control the plan names; re-application replaces only materializer-owned paths and refuses to overwrite shared paths; secret slots resolve at apply time and never enter logs, digests or receipts. `applyWorkspacePlan` writes a local directory, so a remote applier is part of the adapter (open decision D1). | `AC:agent-profile-materialize/src/plan-types.ts:263-324,417-446`; `AC:.../plan-application.ts:1-30` | P2 |
| MAT-6 | C | Every `plan.requires` entry (harness extensions the files cannot establish) is verified present, or the create is refused with the entry's `remedy`. | `AC:agent-profile-materialize/src/plan-types.ts:324-349` | P2 |
| MAT-7 | C | Every axis in `profileMaterializationAxes(profile)` is either materialized with the observable effect in 3.2 or refused at `validateProfile` or `create`. No third state. | `SDK:agent-interface/src/agent-profile-materialization.ts:13-50,237-247`; `RT:agent/profile-materialization.ts:253-275` | P2, P3, P13 |
| MAT-8 | C | A turn whose `profile` or `providerOptions.backend.profile` differs by `canonicalAgentProfileDigest` from the environment's create profile is refused, never run under the old profile. | `EP:provider-turn-input.ts:71-92`; `T:tangle-environment.ts:355-366` | P13 |

#### 3.2 Axis checklist (MAT-7)

Structural proof compares bytes read back from the sandbox to the plan; behavioral proof needs the model and runs under P3. The materializer's own `unsupported` reason string is the refusal text.

| Axes | Required effect | Structural proof | Behavioral proof |
|---|---|---|---|
| `name`, `description`, `version`, `tags`, `metadata` | carried as control fields; no worker behavior; must not fail create | create succeeds | none |
| `harness` | MAT-1, MAT-2 | version probe | none |
| `systemPrompt`, `appendSystemPrompt`, `instructions` | lowered per `harnessSystemPromptIntents`; an intent the harness cannot honor is refused with `systemPromptRefusal` or `appendSystemPromptRefusal` | prompt/context file bytes; flag in harness argv (`/proc/<pid>/cmdline`) | nonce only in the system prompt is returned when asked |
| `modelDefault`, `modelProvider`, `modelSmall`, `modelReasoningEffort` | MOD-1 | env or config names from the harness contract | served model equals declared (MOD-2) |
| `modelMaxVisibleOutputTokens`, `modelMaxReasoningTokens`, `modelMaxTotalOutputTokens` | refused: no workspace control enforces them, and the consumer refuses them upstream | refusal | none |
| `modelMetadata` | `credentialSource` drives MOD-3 or MOD-4; other keys carried | MOD proofs | none |
| `seats` | refused unless the adapter implements the ordered subscription chain; the materializer does not lower it | refusal | none |
| `proxySecrets` | SEC-2 | SEC-2 | none |
| `permissions`, `tools`, `modes` | native policy files from `materializeExecutionControls`; a contradictory set is refused | policy file bytes | a denied tool call fails, with the side effect absent |
| `mcp` | MCP config for the harness; `plan.requires` verified (MAT-6) | config bytes | a stdio probe MCP server records the call the agent was told to make |
| `connections` | refused (the runtime must resolve connections to MCP before create) | refusal | none |
| `subagents` | subagent definition files | file bytes | parent delegates; the child definition is read |
| `resources.files`, `.tools`, `.skills`, `.agents`, `.commands`, `.instructions`, `.failOnError` | files at the profile-chosen paths, bytes exact; tool dirs on the harness PATH | file bytes, mode | skill or command listed by the harness |
| `resources.knowledge` | refused (the runtime resolves knowledge before materialization) | refusal | none |
| `hooks` | hook scripts executable (mode 0755) and registered | file bytes, mode | a tool call triggers the hook marker |
| `confidential` | refused (needs placement and attestation) | refusal | none |
| `extensions` | namespaces the adapter implements; others refused | refusal | none |

### MOD: model routing and credentials

| ID | Tier | Requirement | Evidence | Proof |
|---|---|---|---|---|
| MOD-1 | C | The model is `turn.model ?? profile.model.default`, provider-qualified per `profile.model.provider`, wired through the harness contract's `modelWire` and `envVars`. A harness and model pair the harness table excludes is refused. | `EP:provider-materialization.ts:27-43`; `EP:provider-invocation.ts:47-50`; `SDK:agent-interface/src/harness-capabilities.ts:48-52`; `AC:cli-agent-registry/src/harness-contracts/contracts/claude-code.ts:36-46` | P4 |
| MOD-2 | C | The first event (`execution.started`) and the terminal event carry `data.effectiveBackend = {provider?, model?, source?}` read from what the harness reports, not from the request. A served model differing from the declared one is a consumer identity conflict, and a missing report leaves the receipt unproven. | `RT:sandbox-events.ts:94-107,108-118` (measured: 6 of 6 boxes served a different model, agent-runtime#892); `EP:provider-turn-observer.ts:39-48` | P4 |
| MOD-3 | C | Managed credential source (absent or `"managed"`): model calls reach the Tangle Router with a caller-supplied per-run capped key, delivered only to the harness process under the env name from the harness contract, never in argv or a workspace file. Egress allows the Router host. | `T:tangle-create-options.ts:55-75,254-257`; `SDK:agent-interface/src/provider-config.ts:58-90`; `AC:cli-agent-registry/src/harness-contracts/contracts/claude-code.ts:39-46` | P4, P6 |
| MOD-4 | C | Subscription source (`model.metadata.credentialSource === "subscription"`): either implement it (auth files from `turn.providerOptions.backend.model.{authMode,authFiles}` into the harness HOME at mode 0600, bound to the profile's harness, no mixing of sources in one environment) or refuse at `validateProfile`. It MUST NOT fall back to managed, which would spend per-token. | `T:model-credential-source.ts:6-22`; `T:tangle-environment.ts:355-366`; `EP:provider-executor-admission.ts:107-118`; `EP:provider-turn-input.ts:71-92`; `/Users/drew/company/CLAUDE.md` Inference and Spend Policy | P4, P13 |
| MOD-5 | C | A harness failure carrying an upstream capacity code (`provider_quota_exhausted`, `upstream_unavailable`, `rate_limit_exceeded`, and the others in `UNAVAILABLE_CODES`) or status 429, 503 or 529 reaches the terminal event as `status: "failed"` with `errorCode` and `statusCode` preserved and the code token in `error`. | `RT:supervise/upstream-unavailable.ts:20-36,59-70`; `EP:provider-event-projection.ts:65-110,195-214`; `EP:provider-turn-settlement.ts:224-231` | P10 |

### SEC: secrets delivery

| ID | Tier | Requirement | Evidence | Proof |
|---|---|---|---|---|
| SEC-1 | C | `input.env` reaches the harness process and the default `exec` environment exactly, with names and values bounded strings. | `T:tangle-create-options.ts:466-477` | P6 |
| SEC-2 | C | `secrets`, `proxySecrets`, `proxySecretParents` and `billingOwner` are honored with vendor-native semantics or refused before any vendor call. A name-to-value map is never accepted and dropped. An absent `profile.proxySecrets` capability refuses proxy-only profiles before secret resolution. | `T:tangle-create-options.ts:226-229,296-336`; `SDK:agent-interface/src/agent-profile.ts:573` | P6, P13 |
| SEC-3 | C | No secret value appears in events, errors, `environment.metadata`, receipts, logs or `exec` argv; credential files are mode 0600 under the harness HOME, never under the workspace cwd. | `SDK:agent-interface/src/environment-runtime.ts:870-873`; `AC:agent-profile-materialize/src/plan-application.ts` (resolved values stay out of the public plan); `RT:harness-transcript.ts:460` (credential-shaped paths denied) | P6 |

### TRN: turn protocol and event stream

| ID | Tier | Requirement | Evidence | Proof |
|---|---|---|---|---|
| TRN-1 | C | `stream(input)` parses `AgentTurnInput` with `AgentTurnInputSchema` and refuses before running any field it cannot honor (`contextTransfer`, `nativeContinuation`, `nativeResume`, `interactions`, `detach`, `controlRef`, `lastEventId`, unsupported `parts`). | `SDK:agent-interface/src/environment-runtime.ts:36-95`; `T:tangle-environment.ts:552`; `T:tangle-prompt.ts:55-67` | P13 |
| TRN-2 | C | The prompt is data for the harness, never a shell command. No fallback executes `input.prompt`. | `SDK:agent-interface/src/environment-command-turn.ts:91-95`; `EP:provider-turn-input.ts:138-140` | P3 |
| TRN-3 | C | The harness runs as a child process in the workspace cwd under the applied plan's env and flags, with the harness contract's `storeEnv` set and its `forbiddenArgs` absent, so the native session store lands under HOME where transcript capture reads it. | `AC:cli-agent-registry/src/harness-contracts/contracts/claude-code.ts:15-21`; `RT:harness-transcript.ts:45-58,386-392` | P11 |
| TRN-4 | C | Events are yielded as the harness emits them, not after it exits. `streaming.live` is true only when this is proven. | `SDK:agent-interface/src/environment-command-turn.ts:101-116`; `EP:provider-turn-observer.ts:50-85`; `EP:provider-sandbox-adapter.ts:136-139` | P3 |
| TRN-5 | C | Every event matches `AgentEnvironmentEventSchema`: `type`, bounded `data`, a stable `id` when the harness has one, `normalized` canonical events for text, reasoning and tool parts, `usage` and `usageMode`, and the original frame as `providerEvent`. | `SDK:agent-interface/src/environment-runtime.ts:108-116`; `EP:provider-turn-observer.ts:63-73,87-94`; `T:tangle-events.ts:185-293` | P3 |
| TRN-6 | C | Exactly one terminal event ends the turn: `result` (or `done`, `*.completed`, `*.failed`, `error`, `status`) with `status` `completed` or `failed`, `finalText`, and on failure `error`, `errorCode`, `statusCode`. A non-zero exit or a missing harness result is `failed`. A stream with no terminal event is an error. A vendor SDK that throws on non-zero exit is caught and converted. | `EP:provider-event-projection.ts:65-138,371-394`; `EP:provider-turn-settlement.ts:140-144` | P3, P10 |
| TRN-7 | C | `finalText` is the harness's final assistant message; text deltas are the fallback. | `EP:provider-event-projection.ts:317-327,360-376` | P3 |
| TRN-8 | C | `turn.timeoutMs` bounds the harness run: on expiry the process tree is killed and a failed terminal event names the timeout. The sandbox lifetime exceeds the turn timeout plus capture time (TDN-4). | `SDK:agent-interface/src/environment-runtime.ts:43`; `SDK:agent-interface/src/environment-requests.ts:182-187` | P8 |
| TRN-9 | G | `sessions.continue` is true only if a repeated `sessionId` continues the same harness conversation. Otherwise the adapter does not claim continuation. | `SDK:agent-interface/src/environment-runtime.ts:688-706` | P14 |
| TRN-10 | C | A second `stream` while one is in flight on the same environment is refused or serialized, never interleaved in one workspace. | `T:tangle-capabilities.ts:77`; `EP:provider-execution-loop.ts:132-134` | P12 |

### USE: usage and cost with provenance

| ID | Tier | Requirement | Evidence | Proof |
|---|---|---|---|---|
| USE-1 | C | The terminal event carries the turn's cumulative usage (`usageMode: "cumulative"`) with both `inputTokens` and `outputTokens`; per-call events use `delta`; usage not reported is omitted, never zeroed. Without both counts the consumer marks tokens unknown. | `T:tangle-events.ts:273-293`; `T:tangle-result-values.ts:27-77`; `EP:provider-usage-account.ts:149-158`; `RT:sandbox-events.ts:381-396,430` | P5 |
| USE-2 | C | A dollar amount carries `costProvenance`: `billing-receipt` for the Router's per-key record, `provider-receipt` for a provider receipt, `catalog-estimate` for a price-table computation; a harness's self-reported cost is an estimate and is omitted or marked `uncaptured`. A bare `usage.cost` is stamped `uncaptured` and the spend becomes `usdKnown: false`. | `EP:provider-event-projection.ts:41-57`; `RT:sandbox-events.ts:694-708`; `EP:provider-usage-account.ts:93-95,171-196` | P5 |
| USE-3 | C | Cumulative totals never decrease within an execution and a repeated event id does not double count. | `EP:provider-invocation.ts:111-114`; `RT:sandbox-events.ts:436-446` | P5 |
| USE-4 | C | A failed or aborted turn carries the usage observed so far, in the last frames or on an `AgentExecutionError` receipt. | `EP:provider-turn-settlement.ts:245-248`; `SDK:agent-interface/src/execution-failure.ts:5-26` | P5, P7 |
| USE-5 | C | Vendor sandbox compute dollars never enter `usage.cost`. | `EP:provider-usage-account.ts:171-196` | P5 |

### WSP: workspace

| ID | Tier | Requirement | Evidence | Proof |
|---|---|---|---|---|
| WSP-1 | C | `read`, `write`, `exec` accept the options the consumer passes (`{signal}`, `{sessionId, signal}`, `{cwd, env, timeoutMs, signal}`); relative paths resolve against the workspace cwd; `read` returns exactly the bytes `write` stored; `write` creates parents; `exec` returns the real `{exitCode, stdout, stderr}` with stderr separate and a non-zero exit as a result, not a throw. | `SDK:agent-interface/src/environment-runtime.ts:389-395`; `SDK:agent-interface/src/environment-command-turn.ts:38-62`; `RT:supervise/workspace-checkpoint.ts:23,57,80`; `RT:harness-transcript.ts:386-392,469` | P2, P11 |
| WSP-2 | C | `workspace.cwd` with `base: "repository"` sets the cwd for the harness, `exec` and relative `read`/`write`; `base: "host"` is refused; the default workspace directory is stated. | `T:tangle-create-options.ts:207-213`; `SDK:agent-interface/src/workspace-cwd.ts:91` | P2 |
| WSP-3 | C | `repoUrl` and `gitRef` are cloned into the workspace before create returns; a clone failure fails the create and cleans up. | `SDK:agent-interface/src/environment-requests.ts:92-96` | P1 |
| WSP-4 | C | `workspace.environment` and `workspace.image` map to the vendor's template, snapshot or image with the right SDK key; setting both is refused. | `SDK:agent-interface/src/environment-requests.ts:137-148` | P1, P13 |
| WSP-5 | C | `workspace.checkpoint` restores the files before create returns or the create is refused; an adapter without `create.workspaceCheckpoint` refuses it. An empty workspace is never returned as restored. | `SDK:agent-interface/src/environment-requests.ts:102-113`; `T:tangle-provider.ts:259-286` | P13 |
| WSP-6 | C | `resources` (`cpu`, `memoryMb`, `diskMb`, `gpu`) are honored with the vendor's keys and units or refused. | `SDK:agent-interface/src/environment-requests.ts:151-157` | P13 |
| WSP-7 | G | If the consumer opts into `workspaceRetention`, the environment stays alive and addressable until capture ends, and `exec` plus `read` carry the caller's capture port: archive bytes within the port's bound, no output truncation, `get(id)` works after settle. | `EP:provider-turn-settlement.ts:181-188`; `RT:provider-workspace-retention.ts:35-92` | P11 |
| WSP-8 | G | If `checkpoint`/`fork` are claimed, a fork restores the checkpoint's files, and the vendor key (`snapshotId` for ComputeSDK) is the one the SDK reads. | `SDK:agent-interface/src/environment-runtime.ts:396-400,479-490` | P11 |

### CAN: cancellation

| ID | Tier | Requirement | Evidence | Proof |
|---|---|---|---|---|
| CAN-1 | C | Aborting `turn.signal` kills the harness process tree in the sandbox within a bounded time, the iterator rejects with an `AbortError`, no event follows, and the sandbox stays usable for capture and destroy. | `EP:provider-sandbox-adapter.ts:302-338`; `T:tangle-environment.ts:597-606`; `EP:provider-executor-lifecycle.ts:167-181` | P7 |
| CAN-2 | C | `exec` honors `signal` and `timeoutMs` by terminating the remote command, not by abandoning the client call. | `SDK:agent-interface/src/environment-requests.ts:182-187` | P7, P8 |
| CAN-3 | C | Aborting during `create` leaves no sandbox: the signal reaches the vendor create and a late-arriving sandbox is destroyed. | `T:tangle-provider.ts:311-336` | P9 |
| CAN-4 | C | `destroy()` succeeds while a harness process is running and after a cancelled turn. | `EP:provider-executor-lifecycle.ts:183-216` | P7 |

### TDN: teardown and leak-freedom

| ID | Tier | Requirement | Evidence | Proof |
|---|---|---|---|---|
| TDN-1 | C | `destroy()` deletes the sandbox (not stop, pause or archive); afterwards the vendor lists it absent and `get(id)` returns `null`. | `EP:provider-environment-teardown.ts:104-117`; `T:tangle-environment-control.ts:18-36` | P9 |
| TDN-2 | C | `destroy()` is safe to call twice; the second call resolves. The consumer once met a 409 on a second delete. | `EP:provider-turn-settlement.ts:342-343`; `EP:provider-executor-state.ts:49-51` | P9 |
| TDN-3 | C | Any failure after the vendor create call (readiness, install, materialization, validation, abort) destroys the sandbox before the error surfaces; if destroy fails the error carries the sandbox id as a cleanup handle. | `T:tangle-provider.ts:341-390` (`attachCleanupHandle` at `T:tangle-contract-safety.ts:443`) | P9 |
| TDN-4 | C | Create sets the vendor's finite lifetime (E2B `timeoutMs`; Daytona `autoStopInterval`, `autoDeleteInterval`, `ttlMinutes`, `ephemeral`; ComputeSDK `timeout`) longer than turn timeout plus capture, and tags the sandbox with the run id so a crashed caller cannot leak it indefinitely. | `SDK:agent-interface/src/environment-runtime.ts:910-920` | P9 |
| TDN-5 | C | `list({metadata})` finds a run's sandboxes so an operator can sweep leaks. | `SDK:agent-interface/src/environment-requests.ts:168-180` | P9 |

### ERR: typed errors

| ID | Tier | Requirement | Evidence | Proof |
|---|---|---|---|---|
| ERR-1 | C | Classified failures carry a stable `code` (and `status` for HTTP): refusal before effect (`code`, `path`), capacity (codes and statuses in MOD-5), vendor auth failure (terminal, never retried), not found (surfaced as `null` or `expired`), transport (retryable), abort (`AbortError`), timeout. | `T:model-credential-capacity.ts:5-37`; `T:tangle-session-control.ts:25-34`; `EP:provider-sandbox-adapter.ts:323-338` | P10 |
| ERR-2 | C | A vendor error is kept as `cause`, with secrets scrubbed and the message bounded. | `T:tangle-readiness.ts:68-73` | P10 |
| ERR-3 | C | A refusal names the field or axis refused. | `T:tangle-create-options.ts:345-363` | P13 |

### CON, OPT

| ID | Tier | Requirement | Evidence | Proof |
|---|---|---|---|---|
| CON-1 | C | One provider instance is safe under concurrent create, turn and destroy from many executors; a vendor rate limit surfaces as a capacity error. | `RT:supervise/executor-config.ts:150-165` | P12 |
| OPT-1 | G | A provider that claims `retainedControl`, `nativeContinuation`, `contextTransfer`, `interactions`, `branching`, `exactProcess`, `interactiveTerminal` or `interactiveAgent` MUST pass the matching testkit suite live and the consumer path that needs it; an unclaimed capability is absent. | `EP:provider-execution-source.ts:224-226`; `EP:provider-sandbox-adapter.ts:136-149`; `SDK:agent-provider-testkit/src/index.ts:1-9` | per suite |

## 4. Live proof probes

Every probe runs against a real vendor account, a real harness CLI and a real model, using a per-run capped Router key (company spend policy; never a vault key) and a unique run tag. A probe that cannot run for lack of a credential FAILS; it never skips. A probe passes only when it passes on three consecutive runs where it needs the model. Mock vendors do not count.

| Probe | Run | Pass condition |
|---|---|---|
| P1 Boot | Create with a harness profile, `status()`, exec the contract's `versionCommand`, clone a pinned test repo | `running`; version equals the pin; repo present; placement names the vendor sandbox |
| P2 Plan bytes | Compute `materializeProfile(profile, H, ...)` locally; read every plan file back | bytes, mode and ownership equal the plan; env names appear only in the harness process (`/proc/<pid>/environ`); flags appear in `/proc/<pid>/cmdline`; a plan with `unsupported` entries throws unless `failOnError === false`, then warns |
| P3 Axes | Scripted tasks per 3.2 on the axis probe profile | every behavioral check in 3.2 observed; prompt text never executed as a command; events arrive incrementally (first event before the harness exits); events validate against the event schema |
| P4 Model and credentials | Run a turn on a declared model; read the Router's per-key usage record independently | terminal `effectiveBackend.model` equals declared and equals the Router record; subscription profile without support is refused, never run managed |
| P5 Usage and cost | Run through `providerAsExecutor`; read `Spend` | tokens equal the Router record for the run's key; `usdKnown` is true only with `billing-receipt` provenance; a bare cost yields `usdKnown: false`; a failed turn still carries usage |
| P6 Secrets | Canary value in `env`, a `secrets` entry and the Router key | canary absent from every event, error, metadata, log, `exec` argv and workspace file; credential file mode 0600 under HOME |
| P7 Cancel | Abort at the first event; separately destroy mid-turn | harness process gone within the bound; `AbortError`; no later event; `exec echo ok` still works; destroy resolves; observed usage returned |
| P8 Timeout | `timeoutMs` shorter than the task, and a turn longer than the vendor's default sandbox lifetime | process killed with a terminal event naming the timeout; the long turn completes (lifetime extended) |
| P9 Teardown and leaks | Inject failures (bad image, missing CLI, materialization error, abort during create), destroy twice, `get` after destroy, SIGKILL the client mid-turn | the vendor account (listed with the vendor API, not the adapter) shows zero survivors carrying the run tag after the TTL; `get` is `null`; second destroy resolves |
| P10 Errors | Invalid vendor key; over-cap Router key; unknown image; `get` of a deleted id | each yields the code in ERR-1; capacity propagates `errorCode`/`statusCode` to the terminal event |
| P11 Consumer flow | `createExecutor({backend: 'provider', provider})` runs a task end to end with a real `workspaceRetention` port | result content correct; `harnessTranscript.status === 'captured'`; capture digest matches files the agent wrote; teardown receipt `destroyed: true`; `heldEnvironments()` empty; fork restores files if claimed |
| P12 Concurrency | Four parallel create, turn, destroy on one provider; a second turn on a busy environment | all settle; zero leaks; the busy-environment turn is refused or serialized |
| P13 Refusal matrix | Every unsupported create field, turn field, axis and option | refused with a code and the field name, and the vendor account shows zero new sandboxes |
| P14 Capability document | Base conformance run live with the harness profile (not `{name}`) | schema parses; exposure checks pass for the provider and environment documents |

Each adapter is done when every tier-C requirement is met, the probes above pass live with the run artifact kept, the adapter's mock-only tests are deleted, the vendor account audit is clean, and the PR merged through the local gate.

## 5. What the testkit already checks

Source: `SDK:agent-provider-testkit/src/` at the pinned revision. The kit is framework-neutral: it takes `createProvider()`, so it can run live. No file in the kit or in the three adapter packages reads an environment variable or gates on a credential, and every existing use passes a fake.

| Suite | What it checks | Requirement coverage | Live or fake today |
|---|---|---|---|
| `runAgentEnvironmentProviderConformance` (`provider-conformance.ts:12-263`) | capability schema parse (21-23); `status() === "running"` right after create (66-72); flag and method exposure (80, helpers 52-107); stream emits any event and any terminal event, not a completed one (132-144); usage present only if `requireUsage` or `capabilities.usage` (145-151); keyed create replay and collision, or keyed rejection (35-52, 154-207); dispatch when detach is claimed (229-241); workspace write, read, `exec echo ok` (helpers 27-50); snapshot refusal (246-252); destroy called, not verified (helpers 119-153) | CAP-1, CAP-2, CAP-6, CRT-1, CRT-4, partly CRT-7, partly WSP-1 (the read result is not compared to what was written; `exec` stdout is not checked), TRN-6 (terminal existence only) | adapters pass a mock SDK; the kit's own test uses an in-memory `fakeProvider` (`index.test.ts:105-168`) |
| `runWorkspaceSnapshotConformance` (`workspace-snapshot-conformance.ts`) | an unclaimed `workspaceSnapshot` is refused after reconstruction; optional zero-effect count | part of CRT-2 for one field | mock `effectCount` in each adapter test |
| `runSessionReplayConformance`, `runInteractionResponseConformance`, `runPortableContextConformance`, `runWorkspaceBranchingConformance`, `runInteractiveSessionConformance`, `runAgentExactProcessProviderLifecycleChecks` | the optional tiers in OPT-1 | OPT-1 only | in-memory fakes (`control-conformance.test.ts`) |

Not checked by any kit suite: MAT-1 to MAT-8 (the default profile is `{name}` with `backend: "test"`, `provider-conformance.ts:29-34`, so no harness, model, prompt, tool, mcp, hook or subagent is ever sent), MOD-1 to MOD-5, SEC-1 to SEC-3, TRN-1 to TRN-5, TRN-7 to TRN-10, USE-1 to USE-5, WSP-2 to WSP-6, CAN-1 to CAN-4, TDN-1 to TDN-5 (destroy is called; absence is never checked), ERR-1 to ERR-3, CON-1. Nothing in the kit is a live check. Mock-only checks do not count as proof under the test-value policy, so the base conformance result for any of the three adapters proves nothing about a profile running.

Required kit work, owned by one builder and landed before the adapters: a live profile-execution suite implementing P1 to P14 on the kit's `createProvider` seam, failing (not skipping) when a credential is missing. Three builders must not edit the kit in parallel.

## 6. Provider credentials in the vault

Command: `grep -oE '^[A-Z_]+=' /Users/drew/company/devops/secrets/*.env | grep -iE 'e2b|daytona|computesdk|compute_sdk'`. Output: none (exit 1). Cross-check: 38 `.env` files parsed, 591 distinct key names, none naming these providers; the two files that contain the substring (`integrations.env`, `tangle-router.env`) matched inside encrypted values, not key names. The process environment has no such names either. No value was printed.

| Provider | Credential names the SDK reads | In vault | Consequence |
|---|---|---|---|
| E2B | `E2B_API_KEY` (e2b d.ts `ConnectionOpts`) | absent | no E2B live proof |
| Daytona | `DAYTONA_API_KEY`, optional `DAYTONA_API_URL`, `DAYTONA_TARGET`; alternative `DAYTONA_JWT_TOKEN` + `DAYTONA_ORGANIZATION_ID` | absent | no Daytona live proof |
| ComputeSDK | none of its own in 4.x (gateway removed; `compute.setConfig({provider})` with a backing provider package such as `@computesdk/e2b`) | absent | live proof needs a backing provider's key, so it is blocked by the same E2B or Daytona gap |

Drew supplies the vendor keys. The Router key for model calls in proof runs is minted per run with a hard cap; existing router key names in the vault (for example `TANGLE_API_KEY` in `agent-state.env`) are not used directly.

## 7. Gap table (reading each adapter's source)

`met` the requirement as written holds; `partial` part holds; `missing` it does not. `E` E2B (`E:`), `D` Daytona (`D:`), `C` ComputeSDK (`C:`). "SDK d.ts" cells are static and need a live check.

| ID | E2B | Daytona | ComputeSDK |
|---|---|---|---|
| CAP-1 | met `E:157-166` | met `D:314-323` | met `C:222-231` |
| CAP-2 | met `E:117-126` | partial `git: true` with no git operation `D:319` | missing: checkpoint and fork exposed `C:151-161,177-190` while `branching` is false `C:222-231` |
| CAP-3 | met (one backend) | met (one backend) | missing: static document over a backing provider chosen at runtime `C:77,168` |
| CAP-4 | met all false `E:157-166` | met `D:314-323` | met `C:222-231` |
| CAP-5 | missing: no `validateProfile` `E:65-89` | missing `D:80-125` | missing `C:75-115` |
| CAP-6 | met usage false | met | met |
| CRT-1 | partial: vendor-ready only `E:62-63` | partial: waits for start `D:71-77`, no harness | partial: no readiness check `C:70-73` |
| CRT-2 | partial: 3 of 20 fields refused `E:70-78` | partial: 3 refused `D:85-93` | partial: 3 refused `C:80-88` plus workspace schema `C:209-214` |
| CRT-3 | missing `E:98-143` | met `D:78` | missing `C:124-190` |
| CRT-4 | met `E:76-78` | met `D:91-93` | met `C:86-88` |
| CRT-5 | partial: `null` only when `connect` is absent `E:85`; a gone sandbox throws; no `readOnly` refusal `E:81-88` | partial: 404 to `null`, identity checked, context refused `D:96-113`; `readOnly` and secret options not refused | partial: `readOnly` and context refused `C:94-95`; `get` absent without `getById` `C:91`; secret options not refused |
| CRT-6 | met (no `list`) | partial: ignores `name` and `metadata` `D:114-124` | partial: ignores query, status constant `C:102-112` |
| CRT-7 | missing: constant `running` `E:108` | met `D:155-164` | missing: constant `running` `C:127` |
| CRT-8 | met `E:137` | met `D:202` | met `C:163-172` |
| MAT-1 | missing: profile unread `E:55-64` | missing `D:64-79` | missing `C:66-74` |
| MAT-2 | missing: no install or probe | missing | missing |
| MAT-3 | missing | missing | missing |
| MAT-4 | missing | missing | missing |
| MAT-5 | missing | missing | missing |
| MAT-6 | missing | missing | missing |
| MAT-7 | missing: every axis ignored `E:146-155` | missing `D:218-229` | missing `C:193-207` |
| MAT-8 | missing: turn profile unread `E:109-116` | missing `D:166-173` | missing `C:128-135` |
| MOD-1 | missing: `turn.model` unread `E:109-116` | missing `D:166-173` | missing `C:128-135` |
| MOD-2 | missing: no served-model event `E:109-116` | missing | missing |
| MOD-3 | missing | missing | missing |
| MOD-4 | missing: `credentialSource` unread; runs on whatever the image has | missing | missing |
| MOD-5 | missing: only `exitCode` and `stderr` emitted `SDK:environment-command-turn.ts:108-116` | missing | missing |
| SEC-1 | met `E:151` | missing: key `env`, SDK `envVars` `D:224` (SDK d.ts) | missing: key `env`, SDK `envs` `C:201` (SDK d.ts) |
| SEC-2 | missing: ignored `E:146-155` | missing `D:218-229` | missing `C:193-207` |
| SEC-3 | missing: no mechanism, unproven | missing | missing |
| TRN-1 | missing: only prompt, cwd, timeout, signal read `SDK:environment-command-turn.ts:87-116` | missing | missing |
| TRN-2 | missing: prompt executed as a command when no `turnCommand` `SDK:environment-command-turn.ts:91-95` | missing | missing |
| TRN-3 | missing | missing | missing |
| TRN-4 | missing: runs to exit, then emits `SDK:environment-command-turn.ts:101-116` | missing | missing |
| TRN-5 | missing: `type` and `data` only, no `normalized`, `id`, `usage` | missing | missing |
| TRN-6 | partial: non-zero exit throws `CommandExitError` instead of a failed event `E:129-135` (SDK d.ts) | partial: verdict from exit code only `D:193-200` | partial: same `C:143-149` |
| TRN-7 | partial: command stdout, not the final message | partial | partial |
| TRN-8 | partial: forwards `timeoutMs` `E:132`; no sandbox lifetime | partial: seconds conversion `D:194`; no lifetime | missing: key `timeoutMs`, SDK key `timeout` `C:146` (SDK d.ts) |
| TRN-9 | met (continue false) | met | met |
| TRN-10 | missing: no guard | missing | missing |
| USE-1 | missing: no usage emitted | missing | missing |
| USE-2 | missing | missing | missing |
| USE-3 | missing | missing | missing |
| USE-4 | missing | missing | missing |
| USE-5 | met (no usage emitted) | met | met |
| WSP-1 | partial: `files` ok, options ignored, non-zero exit throws `E:117-136` | partial: write cannot write text `D:181-184`, stderr merged `D:197-199` | partial: read and write bound directly, exec keys wrong `C:136-149` |
| WSP-2 | missing | missing | partial: validated `C:209-214`, forwarded as `cwd` `C:199` (SDK key `directory`) |
| WSP-3 | missing | missing: `source` not a create param `D:222` | missing: keys not read `C:197-198` |
| WSP-4 | partial: environment to template, image ignored `E:147` | met `D:220-221` | partial: `environment` is not an SDK key `C:195` |
| WSP-5 | missing: silently ignored | missing | missing |
| WSP-6 | missing | partial: raw `resources` `D:223` | missing: `resources` is not an SDK field `C:200` |
| WSP-7 | partial: `exec` and `read` exist, never exercised against a port | partial | partial |
| WSP-8 | met (absent, declared false) | met | missing: fork passes `snapshot`, SDK reads `snapshotId` `C:182-185` (SDK d.ts) |
| CAN-1 | partial: `signal` forwarded `E:133`; process kill unproven | missing: pre-check only `D:186` | missing: no `signal` in the SDK options `C:147` (SDK d.ts) |
| CAN-2 | partial: as CAN-1 | partial: server-side timeout `D:194`, abort not forwarded | missing |
| CAN-3 | missing: pre-check only `E:69` | missing `D:84` | missing `C:79` |
| CAN-4 | met `E:138-141` | met `D:203-213` | partial: optional-chained destroy can no-op `C:174` |
| TDN-1 | partial: `kill`, falls back to `close()` `E:139-140`; `get` after destroy throws | met `D:203-213` | partial: `destroy?.(id)` resolves without deleting when absent `C:174` |
| TDN-2 | partial: unproven | met: tolerates 404 `D:210-212` | partial: unproven |
| TDN-3 | missing: no cleanup after create `E:62-63,104` | missing: throws leaving the created sandbox `D:75-77` | missing: `C:73` |
| TDN-4 | missing: no lifetime or tag set `E:146-155` | missing `D:218-229` | missing `C:193-207` |
| TDN-5 | missing: no `list` | partial: lists all, ignores query `D:114-124` | partial: `C:102-112` |
| ERR-1 | missing: plain `Error` strings | missing: structured 404 only `D:273-275` | missing |
| ERR-2 | partial: vendor error unwrapped, unscrubbed | partial | partial |
| ERR-3 | partial: 3 fields named `E:70-77` | partial `D:85-92` | partial `C:80-87` |
| CON-1 | met | partial: new client per call `D:128-132` | met |
| OPT-1 | met (claims none) | met | met (see CAP-2) |

## 8. Open decisions for Drew

- D1 Mechanism. The materializer plan is applied to a local directory (`AC:agent-profile-materialize/src/plan-application.ts:1-30`), and cli-bridge already runs a CLI and parses its stream (`CB:backends/claude.ts:549-550`). A builder can (a) run the plan and the harness runner inside the sandbox from the baked image, or (b) apply the plan through the vendor file API and run the harness through the vendor exec stream. The spec fixes behavior, not mechanism; either must reuse the owners and add no second planner or parser. Whether cli-bridge's backends are importable as a library is unverified.
- D2 Typed errors. ERR-1 needs a shared code set. Today only the Tangle package defines classes (`T:model-credential-capacity.ts`). A new shared error type in agent-interface needs Drew to name it; until then adapters use `code` on `Error`.
- D3 Images. Each vendor needs an image with the harness CLIs at the owner's pins (E2B template, Daytona snapshot, ComputeSDK backing-provider image). The owner of the pins is `AC:cli-agent-registry`; who builds and publishes the three images is undecided.
- D4 E2B keyed create. `e2b@2.62.0` exposes `SandboxOpts.idempotencyKey` (SDK d.ts). Whether it satisfies the same-key-same-environment, changed-input-rejected contract is unproven; CRT-4 holds until it is proven live.

## 9. Limits of this spec

- Vendor SDK facts are static reads of published type definitions; the vendor semantics (for example whether an aborted E2B `commands.run` kills the remote process, or Daytona's `delete` wait default) are unproven until P7 and P9 run.
- Per-harness behavioral checks in 3.2 depend on the harness and the model; the structural proofs do not.
- Optional tiers (OPT-1) are listed, not specified further; none is needed for profile execution.
- The consumer pin is `30516b40`; re-read the cited lines before building if the pin has moved.

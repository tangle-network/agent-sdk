---
"@tangle-network/agent-interface": major
---

Delete exports that no consumer imports.

A search of every checkout and every GitHub repository that depends on this package found no import of the names below, so 3.0.0 removes them. Every remaining export is unchanged, and no remaining type changed shape. A consumer that imports none of these names upgrades by changing its range to `^3.0.0`.

Removed subpaths: `./agent-instance` and `./environment-interactive`. The interactive-session schemas stay on the root, `./environment-provider` and `./environment-interactive-control`.

Removed modules and their exports:

- The agent-instance contract: `AgentInstance*` types, `agentInstance*Schema`, `AGENT_INSTANCE_STATUSES`, `AGENT_INSTANCE_WORKSPACE_MODES`.
- Certified context: `CertifiedContext*` types, `certifiedContext*Schema`, `certifiedContextContentHash`, `certifiedContextEntryContentHash`, `parseCertifiedContext`.
- Generic run control: `AgentRunControlRequest`, `AgentRunControlRequestMaterial`, `AgentRunControlAction`, `AgentRunControlAcknowledgement`, `AgentRunControlRequestSchema`, `AgentRunControlAcknowledgementSchema`, `agentRunControlRequestDigest`, `agentRunControlAcknowledgementMatchesRequest`. Run cancellation is unchanged.

Removed helpers and schemas:

- `validateAgentExecutionPreparationReceipt`, `assertAgentExecutionPreparationReceipt`, `ValidateAgentExecutionPreparationReceiptOptions`. `buildAgentExecutionPreparationReceipt` still validates every receipt it builds; the `execution-binding-mismatch` issue code is gone with the validator that emitted it.
- `assertAgentExecutionWithinLimits`, `agentExecutionLimitObservationSchema`. `refineAgentExecutionWithinLimits` is unchanged.
- `canonicalAgentWorkspaceLeaseRecordDigest` and the lease request and per-phase record aliases (`AgentWorkspaceLeaseAuthorization`, `AgentWorkspaceSealRequest`, `AgentWorkspaceExecutionBindingRequest`, `AgentWorkspaceLeaseRenewalRequest`, `AgentWorkspaceCopyReadyLeaseRecord`, `AgentWorkspaceDestroyingLeaseRecord`, `AgentWorkspaceCleanupFailedLeaseRecord`, `AgentWorkspaceDestroyedLeaseRecord`).
- `validateAndParseInteractionResponse`, `interactionResponseIsValid`. Use `validateInteractionResponse`.
- `assertObservationCredentialFree`, `ObservationState`, `ObservationStateSchema`, `AccountUsage`. Use `observationContainsCredential`.
- `pruneAgentProfileDiff`, `isInputTextPart`, `isInputFilePart`, `isInputImagePart`, `PlanProviderKind`, `PlanProviderKindSchema`, `PlanDecision`, `InteractionFieldType`, `AgentSourceLicense`, `AgentSourceTransformation`, `AgentEnvironmentCreationSchema`.
- `findProfileKbHarness`, `findProfileKbModel`, `profileKbGuidance`, `PROFILE_KB_CHECKED_AT`. `withProfileKb` and the exported knowledge-base records are unchanged.
- Module-internal helpers that were exported by accident: `replayedAgentEnvironmentView`, `agentInteractiveSessionRequestDigest`, `confidentialTeeMatchesRequest`, `validateEmbeddedArtifact`.

# Portable context

**Interaction snapshot.** A current owner read separates outstanding requests from durable response delivery states. An empty request list does not prove delivery, resolution, or owner availability. _Avoid_: deriving pending decisions from transcript text or treating a recorded response as a native effect.

**Seat specification.** A command selector written as `harness/model[@effort]`, parsed into canonical harness identity, unchanged model text, resolved-or-unknown provider and optional reasoning effort. It names no account or credential and is distinct from an authored profile's account-selection stage.

**Local plan.** `PortableContextPlan` contains the complete immutable source, every inclusion or omission, and the selected output. The caller retains it for review and acceptance. Its full source never belongs in a destination transfer request.

**Transfer plan.** `PortableContextTransferPlan` contains the selected typed output, individual commitments to selected source parts and attachments, and a combined commitment to the complete local source and decisions. Omitted parts and explanations have no individual hashes. The destination verifies the accepted digest and selected output without receiving omitted content. Avoid using local plan and transfer plan interchangeably.

**Transfer request.** `ContextTransferRequest` binds the accepted transfer plan to an operation, destination profile, resources, and workspace. `createContextTransferRequest` validates and projects a local plan before constructing this wire request.

**Workspace snapshot reference.** `AgentWorkspaceSnapshotRef` identifies a canonical Runtime manifest and archive through authorized closed artifact references. Its source binding names the existing lease, allocation and snapshot policy. It carries no file bytes or manifest material. The manifest digest describes files; the separate archive digest also binds Git HEAD and the index. Avoid treating a provider-native checkpoint ID or a policy descriptor as transferable bytes.

**Qualified snapshot receiver.** A deployed receiver that authorizes snapshot artifacts, verifies their exact bytes and bounded canonical structure, and restores into a fresh owned destination before agent admission. Only such a receiver advertises `create.workspaceSnapshot`.

**Transfer attachment.** Reconstruction of the destination already admitted by an exact context transfer. `provider.get(id, { contextTransfer })` verifies its durable receipt, returns that receipt on the environment, and enables only the accepted first turn. It never allocates or replaces an environment. Avoid treating ordinary lookup or a repeated create as attachment.

**Proxy secret declaration.** `proxySecrets` requests placeholder-only credential use for an exact destination and presentation. The declaration participates in profile identity; trusted issuer policy grants authority. _Avoid_: treating a named reference as permission or readable environment delivery.

**Proxy secret grant.** A grant pins the resolved tenant, issuer, immutable secret identity and revision to a sandbox epoch, effective scope and absolute expiry. Declared scope and TTL cannot expand issuer policy, authenticated ancestry or source validity.

**Proxy secret receipt.** Metadata acknowledging a particular sandbox generation and the installed grants. Proxy installation precedes placeholder materialization; execution requires both acknowledgments. Binding revocation and upstream credential revocation are separate facts.

**Proxy secret parent selection.** `proxySecretParents` is a host-only total map from destination environment names to API-verified parent sandbox IDs, or explicit independent-root null. It pins host execution custody without becoming portable profile identity or grant authority; the API projects effective pins from validated private parent locators. _Avoid_: parent environment selectors, caller grant IDs, inferred root issuance, or a second persisted map.

**Read-only discovery.** `get(id, { readOnly: true })` returns an existing environment custody snapshot without reconnect or execution side effects. Expired installed receipts remain metadata for trusted recovery decisions; they confer no execution authority. _Avoid_: ordinary reconnect as a discovery fallback.

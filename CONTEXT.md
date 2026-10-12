# Portable context

**Local plan.** `PortableContextPlan` contains the complete immutable source, every inclusion or omission, and the selected output. The caller retains it for review and acceptance. Its full source never belongs in a destination transfer request.

**Transfer plan.** `PortableContextTransferPlan` contains the selected typed output, individual commitments to selected source parts and attachments, and a combined commitment to the complete local source and decisions. Omitted parts and explanations have no individual hashes. The destination verifies the accepted digest and selected output without receiving omitted content. Avoid using local plan and transfer plan interchangeably.

**Transfer request.** `ContextTransferRequest` binds the accepted transfer plan to an operation, destination profile, resources, and workspace. `createContextTransferRequest` validates and projects a local plan before constructing this wire request.

**Workspace snapshot reference.** `AgentWorkspaceSnapshotRef` identifies a canonical Runtime manifest and archive through authorized closed artifact references. Its source binding names the existing lease, allocation and snapshot policy. It carries no file bytes or manifest material. The manifest digest describes files; the separate archive digest also binds Git HEAD and the index. Avoid treating a provider-native checkpoint ID or a policy descriptor as transferable bytes.

**Qualified snapshot receiver.** A deployed receiver that authorizes snapshot artifacts, verifies their exact bytes and bounded canonical structure, and restores into a fresh owned destination before agent admission. Only such a receiver advertises `create.workspaceSnapshot`.

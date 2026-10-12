# Portable context

**Local plan.** `PortableContextPlan` contains the complete immutable source, every inclusion or omission, and the selected output. The caller retains it for review and acceptance. Its full source never belongs in a destination transfer request.

**Transfer plan.** `PortableContextTransferPlan` contains the selected typed output, individual commitments to selected source parts and attachments, and a combined commitment to the complete local source and decisions. Omitted parts and explanations have no individual hashes. The destination verifies the accepted digest and selected output without receiving omitted content. Avoid using local plan and transfer plan interchangeably.

**Transfer request.** `ContextTransferRequest` binds the accepted transfer plan to an operation, destination profile, resources, and workspace. `createContextTransferRequest` validates and projects a local plan before constructing this wire request.

---
"@tangle-network/agent-interface": minor
"@tangle-network/agent-provider-cli-bridge": minor
"@tangle-network/agent-provider-tangle": patch
"@tangle-network/agent-provider-daytona": patch
"@tangle-network/agent-provider-e2b": patch
"@tangle-network/agent-provider-computesdk": patch
---

Allow a qualified provider to reconstruct the existing destination of an accepted context transfer through get, with its authoritative receipt and exact profile, workspace, and resources. The returned handle can admit only that transfer's first turn. Missing or uncertain receipts never fall back to create, and ordinary lookup remains control-only.

CLI Bridge requires deployment-confirmed attachment support. Tangle, Daytona, E2B and ComputeSDK refuse attachment before credentials or platform calls until their receivers support it. This change does not establish live provider handoff.

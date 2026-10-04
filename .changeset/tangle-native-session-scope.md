---
"@tangle-network/agent-provider-tangle": minor
---

Environment evidence capture accepts `workspace: "none"`, which exports the attributed sessions' native evidence without walking the workspace. A caller can now copy a harness session while its turn is still running, or when the workspace is over the byte bound, without the workspace scan failing the whole capture. On 2026-10-04 one Discovery root failed all 12 capture attempts with "Tangle workspace exceeds evidence byte limit", so its native session was never retained. The provenance records `workspaceScope: "none"` and an incomplete workspace inventory, so a native-only capture is never mistaken for a workspace capture.

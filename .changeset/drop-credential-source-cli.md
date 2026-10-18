---
"@tangle-network/agent-provider-tangle": patch
---

Remove `model.metadata.credentialSource: "cli"` (added in 4.3.0, no consumers). The route for a harness-native model is chosen by its model id: Sandbox runs an `opencode/*` model on OpenCode's own provider in CLI mode with no Router key (agent-container #11534), so a profile needs no credential field for it. `credentialSource` again accepts only `managed` or `subscription`.

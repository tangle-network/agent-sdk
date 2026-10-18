---
"@tangle-network/agent-provider-tangle": minor
---

An AgentProfile can state `model.metadata.credentialSource: "cli"`: the harness CLI authenticates its own provider, such as OpenCode's keyless free tier (`opencode/glm-5.3-flash-free`). Sandbox creation maps it to OpenCode CLI mode (`backend.model.mode: "cli"` with the profile's provider and model) and sends no model credential; the credential resolvers skip it; a mapped create or prompt that adds a key or a subscription credential to it is refused. Before, a keyless seat could not be written in a profile, and Sandbox placement sent the free model through the Router, which refused it (503 `provider_pricing_unavailable`).

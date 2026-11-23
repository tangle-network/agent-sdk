---
"@tangle-network/agent-provider-cli-bridge": patch
---

`createCliBridgeProvider({ interactionPolicy })` sets who answers a retained harness's permission prompts. `unattended-allow` makes cli-bridge answer each one with allow, as a one-shot unattended turn already runs. Consumers that never answer interactions (graph runs, lanes, boxes) should set it. The default stays `interactive`.

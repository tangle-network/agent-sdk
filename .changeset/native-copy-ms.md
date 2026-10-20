---
"@tangle-network/agent-provider-tangle": patch
---

Directory evidence capture records `provenance.sessions[].nativeStore.copyMs`: the wall time of the bounded export that copied the session's native store out of the sandbox, so a consumer can measure native copy against a bar.

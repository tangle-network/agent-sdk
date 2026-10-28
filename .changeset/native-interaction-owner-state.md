---
"@tangle-network/agent-interface": patch
---

Expose an optional execution-scoped interaction snapshot on AgentSession. Distinguish available, missing and unavailable owners, retain the existing durable response delivery states independently of outstanding requests, and avoid treating a recorded response as proof of native delivery. The shared schema is the single owner for provider and Sidecar projections; existing session implementations remain valid.

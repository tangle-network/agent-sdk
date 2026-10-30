---
"@tangle-network/agent-core": patch
---

Expose bounded raw field fragments through the existing SSE parser, share its scanner with complete-frame APIs, and cancel the HTTP reader when a decoded-event consumer returns early.

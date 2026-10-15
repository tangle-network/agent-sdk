---
"@tangle-network/agent-interface": patch
---

Reject Keep-Alive, Proxy-Connection, and Proxy-Authenticate proxy-secret header selectors, including case variants, because the proxy strips them before forwarding.

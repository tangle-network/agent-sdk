---
"@tangle-network/agent-core": patch
"@tangle-network/agent-interface": patch
---

Pin zod 4.6.6 to fix GHSA-mrhx-c7xc-m3w5 (zod below 4.6.6: memory exhaustion when an array schema without a length limit validates a large failing input). Consumers inherit the exact pin, so they clear the alert once they take this release.

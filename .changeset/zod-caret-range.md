---
"@tangle-network/agent-core": patch
"@tangle-network/agent-interface": patch
---

Depend on zod `^4.6.6` instead of an exact version. Each Tangle library pinned a different exact zod (4.6.5, 4.6.6 or 4.6.7), so every app installed two or more zod copies, and agent-knowledge's single-copy package check refused the cohort. The range keeps the GHSA-mrhx-c7xc-m3w5 floor (4.6.6) and lets pnpm and npm resolve one copy.

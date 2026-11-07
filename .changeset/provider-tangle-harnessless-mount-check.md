---
"@tangle-network/agent-provider-tangle": patch
---

`validateProfile` refuses an invalid inline file mount, or an oversize profile, before any box exists even when the profile names no harness. Create still applies those checks to such a profile, so validation no longer reports ok for a create that fails.

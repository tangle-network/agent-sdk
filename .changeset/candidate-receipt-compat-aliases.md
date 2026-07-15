---
"@tangle-network/agent-interface": patch
---

Restore the pre-unification candidate outcome and receipt exports as deprecated compatibility aliases so published consumers that still import the old names resolve at ESM import time. Shape-identical renames (profile-plan/benchmark-result material, settlement call and settlement material V2, and their schemas) re-export the current symbols; symbols whose shape changed (bundle/workspace-manifest/execution-plan/materialization-receipt/run-receipt V1, run-receipt V2, the run-receipt union, settlement material V1, and model usage) are re-declared under their frozen shapes. `sameFixedSpend` is re-exported.

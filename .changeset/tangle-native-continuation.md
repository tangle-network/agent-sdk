---
"@tangle-network/agent-provider-tangle": minor
---

Offer verified same-session continuation on a retained Tangle session.

The session now implements `contextBoundary` and `continueNative`, and the adapter declares `nativeContinuation: { atomicBoundary: true, requestIdempotency: true }` wherever it declares retained control. The boundary is the executing run's identity; a continuation is verified against exactly that run and refused with `boundary_mismatch` if another turn has moved it. The continued turn is dispatched through the adapter's own prompt path under the operation id as `turnId`, so the sandbox's turn cache and the adapter's operation record together make a retry replay the original result and control reference without a second dispatch, and a changed turn under the same operation id a `conflict`. `admissionControl` is not claimed, because the adapter learns the continued run's identity from the prompt result.

This is the provider half of letting a re-prompted supervisor continue its own conversation instead of starting a fresh one in a new environment (agent-runtime#1246). It is proven without a sandbox in `native-continuation.test.ts`.

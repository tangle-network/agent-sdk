---
"@tangle-network/agent-provider-tangle": patch
---

Destroy a Tangle environment once, however many owners end it.

One environment has more than one owner of its end: a runtime that destroys on settle and then tears its executor down calls `destroy()` twice for the same box. The platform refuses the second `DELETE` with "A sandbox lifecycle operation is already in progress" while the first delete's cleanup still holds that sandbox's lifecycle lease. Because the second destroy runs inside a caller's `finally`, its throw replaced the run's own outcome, and a completed agent turn was reported as a failed one at zero tokens.

`destroy()` now answers once per environment handle and every later caller joins that answer. This is not a retry and hides no platform error: a delete that fails is not remembered, so the next caller issues a real one.

The header of `tangle-readiness.ts` is corrected with it. It claimed the readiness wait addressed this same error; the measurement withdraws that. The platform guards exactly three routes with the lifecycle lease — resume, stop and delete — and the route a prompt takes is not one of them, so no readiness wait could have prevented it.

Measured 2026-09-01 (#280): 2 of 2 provider-seam runs lost a completed turn this way. On a live box, two concurrent deletes returned one 200 `destroyed` and one 409.

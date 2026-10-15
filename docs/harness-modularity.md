# Harness identity and deployment compatibility

A harness identity in a profile, saved session or execution receipt is historical
information. It is not an installed executable and is not permission to dispatch.
Retire execution through the deployment's active catalog, not by deleting an ID
from `harnessTypeSchema`. `HarnessType` is now inferred from that single schema;
its accepted vocabulary is unchanged, including Forge and the distinct Pi/Prime IDs.

## Native capture capability lists

A newer deployment can advertise an additional harness without invalidating the
known entries in an older client's capability list. The Tangle provider validates
the entire list and projects the recognized subset. Unknown entries never grant
execution support. The selected harness must still be recognized and explicitly
advertised, the native protocol must be version 2, and current/create container
proofs must still agree. Those proof and admission checks are not weakened.

Lists are bounded independently of enum size (256 entries, 128 characters per ID).
Non-arrays, sparse arrays, duplicates (including unknown duplicates), empty IDs,
whitespace/control characters and excessive lengths fail closed. A valid list
containing only unknown IDs projects to an empty list and cannot admit any selected
harness. The returned projection is immutable and does not mutate the wire input.

`harness-catalog-compatibility.test.ts` covers the real provider create/dispatch
boundary using its deterministic SDK client seam, including cleanup before a
prompt when capture is unavailable. It does not claim live native capture or a
real model run. `harness-identity.test.ts` protects historical parsing separately.

## Executed evidence at implementation time

The actual import-free `capture-harness-list.ts` module passed 67 assertions under
Node 22.16.0 type stripping and a strict TypeScript check. Four independently
introduced mutations were detected: rejecting unfamiliar entries, granting them,
accepting duplicate unknown IDs, and removing the list bound. Restoring the source
returned all 67 assertions to passing. Full workspace/provider Vitest and packed
consumer checks were not executed in that local environment (outbound GitHub DNS
was unavailable); remote validation is recorded separately when completed.

## Continuing PRs and acceptance work

The application session-lock repair is agent-app #1116. Selected-catalog factory
ownership and the local positive backend declaration are agent-container #10961.
This SDK branch is the single continuing SDK PR for the same initiative. The
separate Forge-retirement PR #490 overlaps the identity vocabulary: an active
selection may retire Forge, but historical identity should remain readable.

- [x] One runtime schema owns the stable identity type without changing vocabulary.
- [x] Validate mixed-version capability lists without granting unknown execution.
- [x] Preserve selected-harness, protocol and exact-container proof requirements.
- [x] Add historical-identity and provider-boundary regression tests.
- [x] Execute focused source proof and four mutation checks.
- [ ] Run full affected workspace tests, typecheck, build and packed SDK consumers.
- [ ] Complete the deployment availability contract and adoption through actual
      container/API and application selection paths; identity-only lists are not admission.
- [ ] Separate executable installation from read-only historical codec support.
- [ ] Consolidate native invocation/profile/session facts with their integration
      owners without introducing a second runner or capability framework.
- [ ] Verify additive and retired catalogs against real mixed-version deployment
      documents, historical records, and exact native resume/cancel behavior.
- [ ] Review, merge, publish and adopt the package cohort through maintained release
      automation; validate the served result. No production support is retired here.

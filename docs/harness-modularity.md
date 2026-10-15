# Harness identity and deployment compatibility

A harness identity in a profile, saved session or execution receipt is historical
information. It is not an installed executable and is not permission to dispatch.
Retire execution through the deployment's active catalog, not by deleting an ID
from `harnessTypeSchema`. `HarnessType` is inferred from that single schema;
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

`harness-catalog-compatibility.test.ts` covers the provider create/dispatch
boundary using its deterministic SDK client seam, including cleanup before a
prompt when capture is unavailable. It does not claim live native capture or a
real model run. `harness-identity.test.ts` protects historical parsing separately.

## Production package closure

The Tangle provider now cleans its output and builds from its two public
entrypoints with `tsconfig.build.json`. TypeScript emits their transitive production
modules; the package publishes that `dist` directory rather than a hand-maintained
list of individual files. Tests and unrelated fixtures are not build entrypoints.
This fixes the concrete packed-consumer failure where the new internal list reader
was present in the workspace but absent from the published tarball.

## Executed evidence

The import-free list reader passed 67 assertions under Node 22.16.0 and strict
TypeScript checking. Four independently introduced mutations were detected:
rejecting unfamiliar entries, granting them, accepting duplicate unknown IDs, and
removing the list bound. Restored source passed all 67 assertions again.

GitHub Actions run **38685170842**, artifact **11949930635**, verified commit
`fce8c6e2a4455b87dd31144fc85f5c9aeb836eab` with all five maintained checks passing:

- `pnpm -r build`.
- `pnpm -r check-types`.
- `pnpm -r test`: **2,346 passed**, 5 skipped across the workspace (including the
  new identity and composed Tangle provider tests).
- `pnpm check:package-artifacts`: packed interfaces, providers, session readers
  and their isolated consumers pass.
- `pnpm check:control-artifacts`: the packed control-fidelity consumer passes.

The earlier proof correctly failed the packed-consumer checks on the omitted
helper. The packaging change above repaired the failure; no check was disabled.
These are source/package contract results, not native CLI or production proof.
Subsequent documentation-only updates and removal of the temporary proof runner
do not retroactively change the commit named by this receipt.

## Continuing PRs and acceptance work

The application session-lock repair is agent-app #1116. Selected-catalog factory
ownership and the local positive backend declaration are agent-container #10961.
This is the single continuing SDK PR (#498) for the initiative. The separate
Forge-retirement PR #490 overlaps identity vocabulary: an active selection may
retire Forge, but historical identity should remain readable.

- [x] One runtime schema owns the stable identity type without changing vocabulary.
- [x] Validate mixed-version capability lists without granting unknown execution.
- [x] Preserve selected-harness, protocol and exact-container proof requirements.
- [x] Add historical-identity and provider-boundary regression tests.
- [x] Execute focused source proof and four mutation checks.
- [x] Run full workspace tests, typecheck, build and packed SDK consumers.
- [x] Publish the production module closure without a second manual file inventory.
- [ ] Complete deployment availability and adoption through actual container/API
      and application selection paths; identity-only lists are not admission.
- [ ] Separate executable installation from read-only historical codec support.
- [ ] Consolidate native invocation/profile/session facts with their integration
      owners without introducing a second runner or capability framework.
- [ ] Verify additive and retired catalogs against real mixed-version deployment
      documents, historical records, and exact native resume/cancel behavior.
- [ ] Review, merge, publish and adopt the package cohort through maintained release
      automation; validate the served result. No production support is retired here.

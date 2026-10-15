# Harness identity and deployment compatibility

A harness identity in a profile, saved session or execution receipt is historical
information. It is not an installed executable and is not permission to dispatch.
Retire execution through the deployment's active catalog, not by deleting an ID
from `harnessTypeSchema`. `HarnessType` is inferred from that single schema;
its accepted vocabulary is unchanged, including Forge and the distinct Pi/Prime IDs.

## Native capture capability lists

A newer deployment can advertise an additional harness without invalidating known
entries in an older client. The Tangle provider validates the entire list and
projects the recognized subset. Unknown entries never grant execution support.
The selected harness must still be recognized and explicitly advertised, the native
protocol must be version 2, and current/create container proofs must agree. Those
proof and admission checks are unchanged.

Lists are bounded independently of enum size: 256 entries, 128 characters per ID.
Non-arrays, sparse arrays, duplicates (including unknown duplicates), empty IDs,
whitespace/control characters and excessive lengths fail closed. A valid list with
only unknown IDs projects to an empty list and cannot admit any selected harness.
The projection is immutable and does not mutate the wire input.

`harness-catalog-compatibility.test.ts` covers the provider create/dispatch/cleanup
boundary using its deterministic SDK client seam. This is not live native capture
or a real model run. `harness-identity.test.ts` protects historical parsing separately.

## Production package closure

The provider cleans its output and builds from its two public entrypoints through
`tsconfig.build.json`. TypeScript emits their transitive production modules; the
package includes that `dist` directory instead of a second manual list of individual
output files. Tests and unrelated fixtures are not build entrypoints. This repairs
the concrete packed-consumer failure where the new reader existed in the workspace
but was missing from the tarball. No package publication is claimed by this PR.

## Executed evidence

The import-free list reader passed 67 assertions under Node 22.16.0 and strict
TypeScript checking. Four separately introduced mutations were detected: rejecting
unfamiliar entries, granting them, accepting duplicate unknown IDs and removing the
list bound. Restored source passed all 67 assertions again.

Actions run **38685170842**, artifact **11949930635**, verified source
`fce8c6e2a4455b87dd31144fc85f5c9aeb836eab`. All five maintained checks passed:

- `pnpm -r build`.
- `pnpm -r check-types`.
- `pnpm -r test`: **2,346 passed** across ten package test summaries, including
  identity and composed provider tests. These summaries report no skipped tests.
- `pnpm check:package-artifacts`: isolated packed consumers pass.
- `pnpm check:control-artifacts`: the packed control-fidelity consumer passes.

The earlier proof correctly failed packed consumers on the omitted helper. The
production-closure build repaired it; no check was disabled. These are source/package
contracts, not native CLI or production proof. Documentation-only changes and removal
of the temporary proof runner are not retroactively part of the verified source SHA.

## Continuing PRs and acceptance work

Continue SDK **#498**, agent-app **#1116**, and agent-container **#10961**. The separate
Forge-retirement PR #490 overlaps identity vocabulary: a deployment may retire Forge,
but historical identity should stay readable.

- [x] One schema owns the stable identity type without changing vocabulary.
- [x] Validate additive catalogs without granting unfamiliar execution.
- [x] Preserve selected-harness, protocol and exact-container proof checks.
- [x] Add identity and composed provider regression tests.
- [x] Execute focused source proof and four mutation checks.
- [x] Run workspace tests, typecheck, build and packed consumers.
- [x] Build and pack the production closure without a manual file inventory.
- [ ] Complete deployment availability and adoption through real container/API/app
      selection paths; identity-only lists are not admission.
- [ ] Keep historical read-only codecs usable independently of installed executables.
- [ ] Consolidate native invocation/profile/session facts with their integration
      owners without introducing another runner or capability framework.
- [ ] Verify real mixed-version catalogs, old records and exact native resume/cancel.
- [ ] Review, merge, publish, adopt the package cohort and validate served behavior
      through maintained release automation. No production support is retired here.

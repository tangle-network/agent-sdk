# Agent delivery

Work on a feature branch. Run relevant checks while developing and report their actual results. Push and open a PR into `main`, then use GitHub's native expected-head merge when authorized:

```sh
gh pr merge <PR> --merge --match-head-commit <INTENDED_HEAD_SHA>
```

Capture the intended head before invoking the command. Drafts, explicit holds, conflicts and native repository restrictions still apply. Do not use `--admin`, forge statuses, or change repository settings to land a change. A queued or pending request is not a completed merge: read back `mergedAt` and `mergeCommit` before reporting completion.

Before merging, run the local Beelink gate. Repositories carry no PR or push CI; release PRs and external contributions retain their qualification. A skipped job is not a test pass. No additional merge wrapper or host installation is required.

Local Beelink gate (set `PACKAGE` to the affected workspace package; the gate installs from the frozen pnpm lockfile and runs that package's whole `test` script, because a change can pass its own test file and break another in the same package): `beelink-gate auto https://github.com/tangle-network/agent-sdk.git "$(git rev-parse HEAD)" -- sh -c 'pnpm -r build && pnpm -r check-types && pnpm --filter "$1" test' _ "${PACKAGE:?set affected workspace package}"`.

Package publication is separate: the existing release workflow owns version, artifact, provenance and publishing-identity checks. A merged change is not a published package or a consumer adoption.

Use existing workspace verification commands as applicable: `pnpm -r build`, `pnpm -r check-types`, `pnpm -r test`, `pnpm check:package-artifacts`, `pnpm check:control-artifacts`, and the maintained CLI Bridge integration. Never publish or dispatch production merely to complete a source-only task.

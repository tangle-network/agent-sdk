# Agent delivery

Work on a feature branch. Run relevant checks while developing and report their actual results. Push and open a PR into `main`, then use GitHub's native expected-head merge when authorized:

```sh
gh pr merge <PR> --merge --match-head-commit <INTENDED_HEAD_SHA>
```

Capture the intended head before invoking the command. Drafts, explicit holds, conflicts and native repository restrictions still apply. Do not use `--admin`, forge statuses, or change repository settings to land a change. A queued or pending request is not a completed merge: read back `mergedAt` and `mergeCommit` before reporting completion.

Ordinary internal feature PRs do not require local signoff or CI qualification. CI verifies landed revisions; release PRs and external contributions retain their verification. A skipped job is not a test pass. No additional merge wrapper or host installation is required.

Package publication is separate: the existing release workflow owns version, artifact, provenance and publishing-identity checks. A merged change is not a published package or a consumer adoption.

Use existing workspace verification commands as applicable: `pnpm -r build`, `pnpm -r check-types`, `pnpm -r test`, `pnpm check:package-artifacts`, `pnpm check:control-artifacts`, and the maintained CLI Bridge integration. Never publish or dispatch production merely to complete a source-only task.

# Agent delivery

Work on a feature branch. Run relevant checks while developing and report what actually ran. Push the branch and use `tangle-ops merge` to land it in `main`. Source landing does not require a green CI run, local signoff, release version, published dependency, or queue label. Do not wait for post-merge CI before finishing a source-only task. A draft or explicit merge hold is not permission to merge.

`CI` verifies landed revisions and supports manual verification. It retains the complete SDK build, type, test, packed-artifact and real CLI Bridge checks. A failed or cancelled run is not a pass; fix a regression on a new branch without blocking unrelated source work.

Package publication is a separate effect. Keep the existing release workflow's version, artifact, provenance, upstream-source and publishing-identity checks. Do not publish from a feature branch, dispatch a release, change repository protection, or substitute a dependency version merely to finish a source task. Report package adoption and publication separately from merge completion.

The shared `tangle-ops merge` implementation must be installed before using that command. During rollout, the equivalent source-only operation is the ordinary GitHub merge endpoint with the exact intended head SHA. Native repository restrictions still apply: never use an administrator bypass, forge check results, or alter a protection rule to land your own change. Administrators must remove obsolete CI-required-check settings as a separate configuration rollout.

## Verification

Use the existing workspace scripts: `pnpm -r build`, `pnpm -r check-types`, `pnpm -r test`, `pnpm check:package-artifacts`, `pnpm check:control-artifacts`, and the maintained CLI Bridge integration command when that boundary changes. These are development and release tools, not an additional merge ceremony.

---
"@tangle-network/agent-provider-cli-bridge": minor
"@tangle-network/agent-provider-daytona": minor
"@tangle-network/agent-provider-computesdk": minor
---

Vendor snapshots: checkpoint and fork on every cloud that snapshots.

- `BridgeSandboxVendor` gains an optional `snapshots.create(sandboxId)` lifecycle and `BridgeSandboxCreateRequest` gains a `snapshot` restore field, distinct from a caller-chosen `environment`.
- `createBridgeSandboxProvider` environments expose `checkpoint()` and `fork(ref)` exactly when the vendor snapshots; a vendor without the lifecycle refuses both, as it refuses every capability it cannot honor. A fork reuses the source create input minus what the snapshot already carries (repository, git ref, environment, image), keeping the requested working directory.
- Daytona: snapshots a running sandbox by name and restores it through `create({ snapshot })`.
- computesdk: accepts the computesdk snapshot manager, restores through `CreateInstanceOptions.snapshotId`, and honors `workspace.image` (the image must be box-compatible; build one with `pnpm build:sandbox-image --base-image`, which parameterizes the box Dockerfile's base layer without touching the pinned Bridge and harness installs).

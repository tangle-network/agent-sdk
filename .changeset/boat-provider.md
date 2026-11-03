---
"@tangle-network/agent-provider-boat": minor
---

New Boat (boat.dev) vendor adapter: environments are Boat sandboxes running CLI Bridge.

Boat exposes no custom images, so a fresh create installs the box's exact pins through Boat's `setupScript`; booting a prepared snapshot (`from`, `workspace.environment`, or a fork) skips the install. `checkpoint()`/`fork()` map to Boat's named snapshots through `create({ from })`. The adapter is offline-typed against `@boatdev/sdk` and marked experimental until a live conformance run proves it.

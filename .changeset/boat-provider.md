---
"@tangle-network/agent-provider-boat": minor
---

New Boat (boat.dev) vendor adapter: environments are Boat sandboxes running CLI Bridge.

Boat exposes no custom images, so a fresh create installs the box's exact pins through Boat's `setupScript`; booting a prepared snapshot (`from`, `workspace.environment`, or a fork) skips the install. `checkpoint()`/`fork()` map to Boat's named snapshots through `create({ from })`, and the capability document advertises `branching.checkpoint`/`branching.fork` exactly when the vendor snapshots. The adapter is typed against `@boatdev/sdk` and ships the live conformance suite (`tests/boat-live.integration.test.ts`); it runs once `BOAT_API_KEY` is supplied. The vendor-snapshot seam it rides is live-proven on the Docker box.

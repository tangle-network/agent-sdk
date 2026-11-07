# @tangle-network/agent-provider-boat

## 0.1.1

### Patch Changes

- 67241c8: The box reads its harness set, versions and version probes from the harness catalog (`HARNESSES` in `@tangle-network/cli-agent-registry` 0.15.30, generated from agent-container's `agent-clis.json`), so it carries the Tangle sandbox image's CLI versions (`claude-code` 2.1.318, was 2.1.311). Every Router-eligible catalog harness is a box recipe or a `BOX_EXCLUSIONS` row with its reason and owner. `boxInstallScript()` is the one install step for the image and Boat. The image build refuses a registry lockfile behind the latest publish. The testkit's version and process probes come from the catalog instead of its own tables.
- Updated dependencies [67241c8]
- Updated dependencies [9d6cc6c]
  - @tangle-network/agent-provider-cli-bridge@2.0.10

## 0.1.0

### Minor Changes

- 4948c06: New Boat (boat.dev) vendor adapter: environments are Boat sandboxes running CLI Bridge.
  
  Boat exposes no custom images, so a fresh create installs the box's exact pins through Boat's `setupScript`; booting a prepared snapshot (`from`, `workspace.environment`, or a fork) skips the install. `checkpoint()`/`fork()` map to Boat's named snapshots through `create({ from })`, and the capability document advertises `branching.checkpoint`/`branching.fork` exactly when the vendor snapshots. The adapter is typed against `@boatdev/sdk` and ships the live conformance suite (`tests/boat-live.integration.test.ts`); it runs once `BOAT_API_KEY` is supplied. The vendor-snapshot seam it rides is live-proven on the Docker box.

### Patch Changes

- Updated dependencies [4948c06]
  - @tangle-network/agent-provider-cli-bridge@2.1.0

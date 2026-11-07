---
"@tangle-network/agent-provider-cli-bridge": patch
"@tangle-network/agent-provider-testkit": patch
"@tangle-network/agent-provider-boat": patch
---

The box reads its harness set, versions and version probes from the harness catalog (`HARNESSES` in `@tangle-network/cli-agent-registry` 0.15.30, generated from agent-container's `agent-clis.json`), so it carries the Tangle sandbox image's CLI versions (`claude-code` 2.1.318, was 2.1.311). Every Router-eligible catalog harness is a box recipe or a `BOX_EXCLUSIONS` row with its reason and owner. `boxInstallScript()` is the one install step for the image and Boat. The image build refuses a registry lockfile behind the latest publish. The testkit's version and process probes come from the catalog instead of its own tables.

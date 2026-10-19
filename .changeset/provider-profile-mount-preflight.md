---
"@tangle-network/agent-provider-tangle": patch
---

The provider's `validateProfile` now runs the Sandbox SDK's create-time check of a profile's inline file mounts (`splitInlineProfileFileMounts` + `validateDeferredProfileFileMounts`) before any box exists, and returns a refusal as an `error` issue with the SDK's code and path (`PROFILE_FILE_MOUNT_INVALID` when the SDK gives none). A caller-supplied `validateProfile` still runs and its issues are kept. A coordinator can call it in its spawn preflight and return the refusal to the caller instead of creating boxes that fail at create.

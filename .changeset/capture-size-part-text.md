---
"@tangle-network/agent-provider-tangle": patch
---

Keep Tangle evidence captures small. A streamed `message.part.updated` whose text is exactly the part's previous text plus its `delta` keeps the delta and drops the repeated text (`part.textFromDeltas: true`; both retained files declare `partText: "delta-when-text-equals-previous-plus-delta"`), in the session transport file and the native manifest's frames. Files under a harness's `node_modules` keep their inventory metadata (size, digest) with `contentOmitted: "harness-install"` and no bytes. A 1.43 GB Discovery capture was 1.44 GB of repeated part text and 52 MB of OpenCode's installed packages.

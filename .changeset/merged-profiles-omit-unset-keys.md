---
"@tangle-network/agent-interface": minor
---

Omit unset optional keys from merged and diffed profiles instead of writing them as `undefined`.

`mergeAgentProfiles` wrote every axis it resolved, so merging two profiles that mention neither `tools` nor `mcp` still produced `{ tools: undefined, mcp: undefined, … }` — eleven keys on a two-key merge. RFC 8785 canonicalization enumerates own keys, so that shape is not the same document as one omitting them: `canonicalCandidateJson` refuses it outright. `applyAgentProfileDiff` and `defineGitHubResource` blanked keys the same way and now delete them.

This changes published merge semantics, so it is a minor rather than a patch: an overlay entry holding `undefined` no longer erases the base value. `{ harness: 'codex' }` merged with `{ harness: undefined }` now keeps `codex`, matching the rule profile canonicalization already applies — an `undefined` entry reads as "not specified", and removal stays the `remove` channel's job.

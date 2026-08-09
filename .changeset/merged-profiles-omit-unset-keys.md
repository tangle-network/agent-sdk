---
"@tangle-network/agent-interface": patch
---

Omit unset optional keys from merged, diffed, and pruned profiles instead of writing them as `undefined`.

`mergeAgentProfiles` wrote every axis it resolved, so merging two profiles that mention neither `tools` nor `mcp` still produced `{ tools: undefined, mcp: undefined, … }` — eleven keys on a two-key merge. RFC 8785 canonicalization enumerates own keys, so that shape is not the same document as one omitting them: `canonicalCandidateJson` refuses it outright, and any digest taken over a merged profile stops being a function of profile content. `applyAgentProfileDiff`, `pruneAgentProfileDiff`, and `defineGitHubResource` blanked keys the same way and now delete them.

An `undefined` entry on an input reads as "not specified" rather than as a removal, matching the rule profile canonicalization already applies: an overlay carrying `harness: undefined` keeps the base harness, and removal stays the `remove` channel's job.

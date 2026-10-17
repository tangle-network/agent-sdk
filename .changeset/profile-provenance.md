---
'@tangle-network/agent-interface': minor
---

Add `mountSkill(source, content)` and `verifyResourceProvenance(profile, { read })`. `mountSkill` returns an inline skill and its provenance record (repository, full commit SHA, path, SHA-256). `verifyResourceProvenance` returns every reason the records at `extensions[<profile name>].resourceProvenance` do not hold: a ref that is not a commit, a record naming no inline resource, inline bytes that do not hash to the record, and, with `read`, source bytes at that commit that do not hash to it.

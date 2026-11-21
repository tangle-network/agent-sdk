---
"@tangle-network/harness-sessions": minor
---

Keep a marked Prime session's recorded identity everywhere it is found: `isPrimeSessionHeader` recognizes Prime's `rlmDepth` header marker (zero depth included, ordinary Pi headers excluded), locate and read carry the recorded session ID, cwd and `parentSession`-proven parent instead of the store filename, and `readSessionInput`/`summarizeSessionInput` accept `prime` input through the same fold. A session whose header records a fork exposes `fork` provenance (parent ID, verbatim reference, `rlmDepth`, `userFork`, creation time) and marks replayed prehistory per message with `inherited`, so a forked tool call stays attributable to its root session. Unmarked historical recordings keep their established store-filename identity.

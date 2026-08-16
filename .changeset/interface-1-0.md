---
"@tangle-network/agent-interface": major
---

Adopt a stated compatibility promise and release it as 1.0.0.

The published surface of 1.0.0 equals the published surface of 0.56.0.
No export is added, removed, or narrowed by this release.
The version number changes so that a caret range can read the promise the package already keeps.

The promise from this release forward:

- A minor release is additive. A new export, a new optional field, and a widened union are minor.
- A patch release is a fix. A behaviour correction that keeps every declared type is patch.
- A major release removes or narrows. A deleted export, a removed member, a narrowed type, and a new required field are major.

Consumers must declare `^1.0.0`.
A caret range admits every additive minor without a consumer release.
The single-generation window `>=X.Y.0 <X.(Y+1).0` is retired and must not be reintroduced.

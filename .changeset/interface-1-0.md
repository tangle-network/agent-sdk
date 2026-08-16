---
"@tangle-network/agent-interface": major
---

Adopt a stated compatibility promise and release it as 1.0.0.

The published surface of 1.0.0 equals the published surface of 0.56.0.
No export is added, removed, or narrowed by this release.
The version number changes so that a caret range can read the promise the package already keeps.

The promise from this release forward:

- A minor release is additive. A new export, a new optional field, and a new member on an exported union are minor.
- A patch release is a fix. A behaviour correction that keeps every declared type is patch.
- A major release removes or narrows. A deleted export, a removed member, a narrowed type, and a new required field are major.

Two limits of that promise, stated because a caret range makes them reachable:

- A `switch` over an exported union must have a `default` branch. An exhaustiveness check that assigns the remaining case to `never` fails when a minor adds a member, and this promise does not cover it.
- Declare the lowest 1.x you actually use. A package that reads an export added in 1.4.0 must declare `^1.4.0`, because `^1.0.0` lets a resolver keep 1.0.0.

Consumers must declare `^1.<lowest minor used>.0`.
A caret range admits every later additive minor without a consumer release.
The single-generation window `>=X.Y.0 <X.(Y+1).0` is retired and must not be reintroduced.

---
"@tangle-network/agent-interface": patch
---

`canonicalCandidateDigest` hashes the RFC 8785 encoding piece by piece instead of building the whole string and a byte copy first. The digest is byte-for-byte the same. Its peak memory on a 101 MiB provider event stream (108,093 events) falls from 1,501 MiB RSS to 643 MiB, the size of the parsed value itself. `canonicalCandidateJson` and the digest now share one serializer.

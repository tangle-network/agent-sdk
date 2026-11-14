---
"@tangle-network/agent-interface": patch
---

`canonicalCandidateDigest` hashes the RFC 8785 encoding in 64 Ki-character chunks instead of building the whole string and a byte copy first. The digest is byte-for-byte the same. On a 101 MiB provider event stream (108,093 events) hashing no longer raises peak memory above parsing the value (697 MiB RSS, against 1,455 MiB before), and it takes 1,169 ms against 1,627 ms. `canonicalCandidateJson` and the digest now share one serializer.

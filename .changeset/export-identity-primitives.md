---
"@tangle-network/agent-interface": patch
---

Export the candidate identity primitives (`Sha256Digest`, `sha256DigestSchema`, `sha256Utf8`, `sha256Bytes`, `canonicalCandidateJson`, `canonicalCandidateBytes`, `canonicalCandidateDigest`) as explicit named exports on the package root so external consumers can rely on them independent of internal barrel layout.

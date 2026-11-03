---
"@tangle-network/harness-sessions": patch
---

`listCapture` no longer parses a retention `raw-manifest.json` whole: it streams only the fields a listing reads (`nativeSessions`, `source.backendType`, `source.nativeSessionId`, `source.attempts[].{nativeSessionIds, executionId, ordinal}`), so a manifest past V8's string limit (production evidence: 1.27 GB) lists its sessions instead of failing as `Invalid string length`. One session's unreadable manifest now lands in `missing` as `manifest_unreadable` instead of sinking the capture's whole listing.

Closes #534.

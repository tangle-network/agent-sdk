---
"@tangle-network/agent-provider-tangle": patch
---

Prepare secret-bearing native turns through Sandbox's isolated-session and prelaunch-receipt APIs before stream, detached dispatch or session prompt. Keep bearer values out of persisted session creation and retained request identity. Fresh environments without an authored working directory or SDK Git checkout use the existing SDK create `cwd` field to place all initial inputs, repository setup and later sessions in one `workspace` child; explicit working directories, SDK Git roots, checkpoint restoration and existing environment lookups remain unchanged. Replaying an older create key with a different default working directory can refuse as a changed request; it never relocates the original workspace.

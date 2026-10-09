---
"@tangle-network/agent-provider-tangle": patch
---

Reconnect to a stopped sandbox: `get()` now resumes the sandbox before it requires a native capture proof. A stopped sandbox has no container and reports no proof, so the old order refused every reconnect with "Tangle native session capture has no verified current container proof" and never ran the resume.

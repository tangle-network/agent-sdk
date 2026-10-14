---
"@tangle-network/agent-interface": patch
---

Preserve own metadata and record keys such as `__proto__` when merging profiles or applying profile diffs, without changing the returned record's prototype. Undefined overlay entries remain unspecified.

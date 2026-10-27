---
"@tangle-network/agent-interface": patch
---

Profile metadata bounds strings by the 1 MiB serialized budget instead of 16 KiB per string, so metadata that copies a valid profile (such as a graph node with a large inline file) is admitted again; node, depth, entry and accessor bounds are unchanged.

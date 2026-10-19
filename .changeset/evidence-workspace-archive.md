---
"@tangle-network/agent-provider-tangle": patch
---

Export the evidence workspace as one Sandbox `downloadArchive` stream per top-level directory instead of one listing per directory plus serial 100-file batch reads. Each archive is verified against its SHA-256 receipt and recorded in `provenance.workspace.archives`. A 32 MB workspace exported in 17.7-19.9 s on a live box (4.4.2: 227.9 s). Credential and runtime-owned top-level directories are never archived. Archived entries carry the archive metadata: `modifiedAt` to the second, `accessedAt` null, and directory `sizeBytes` 0.

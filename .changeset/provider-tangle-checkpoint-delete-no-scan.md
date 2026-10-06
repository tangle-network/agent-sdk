---
"@tangle-network/agent-provider-tangle": patch
---

Delete a workspace checkpoint without scanning the account's sandbox inventory. A child created from a checkpoint holds a full restore of it, so deleting the checkpoint does not change the child; only Sandbox's last-resort sidecar recreation still names it, and that replay then fails with `SNAPSHOT_NOT_FOUND` (agent-dev-container#9388). The scan paged a listing Sandbox rebuilds on every page; on a busy account it failed, deletion was never attempted, and Runtime kept the source sandbox running after its run settled.

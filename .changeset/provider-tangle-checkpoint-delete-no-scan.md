---
"@tangle-network/agent-provider-tangle": patch
---

Delete a workspace checkpoint without scanning the account's sandbox inventory. A child created from a checkpoint holds a full restore of it, so no child depends on the checkpoint. The scan paged a listing Sandbox rebuilds on every page; on a busy account it failed, deletion was never attempted, and Runtime kept the source sandbox running after its run settled.

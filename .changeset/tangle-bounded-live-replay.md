---
"@tangle-network/agent-provider-tangle": patch
---

A native capture of a running turn now stores the events the Sidecar had buffered when the capture started, ending at the replay end marker, instead of following the live turn until it finished. Every 2-minute copy of a live turn previously blocked until the turn ended or the caller timed it out, so a box lost mid-turn kept no copy of its session.

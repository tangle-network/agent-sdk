---
"@tangle-network/agent-interface": patch
---

Give the durable workspace checkpoint and fork schemas one owner for the two rules they share.
`refuseSelfConflict` states once that a conflict answer must name a different existing request, and `operationResourceIdentityMatches` states once that the checkpoint or forked environment an answer carries must repeat the key and digest of the operation that made it.
The four result and lookup schemas now call them instead of restating each rule.
The public types, the accepted and refused values, and every issue path and message are unchanged.

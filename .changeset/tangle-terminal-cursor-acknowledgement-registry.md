---
"@tangle-network/agent-provider-tangle": patch
---

Hold the Tangle terminal to its replay window, its attach result, and its registry lifetime.

`events()` called with no cursor now starts at the oldest frame the log still retains, resolved when the read begins.
It previously started at cursor 0, which the log refuses once the bounded buffer has evicted an output frame, so a consumer that held no cursor was locked out of a terminal it had just attached.
A cursor the consumer names is still refused when its successors were evicted, because the consumer believes it received the frames that gap would drop.

`attachTerminal()` now reads the ready acknowledgement inside a guard and reports a failed read as `unknown` with the structured cause.
The Sandbox stream exposes `ready` as an accessor that throws before the runtime acknowledges, so an unguarded read replaced the attach result with a raw transport error and abandoned the socket the attach had opened.
That error states the request URL, and the URL can carry a credential, so the result names the read and the cause instead.

A terminal handle now releases its registry entry when it detaches or closes, so a long-lived provider does not retain every terminal it ever attached.
A handle releases only the entry built on its own socket, so a stale handle cannot evict the terminal a later attach installed.

---
"@tangle-network/agent-provider-tangle": patch
---

Bind a Sandbox event's session identity to the field position that carried it.
The run-frame position (`data.sessionId`/`data.sessionID`) holds the
harness-native session id on `session.updated`, so a stream-bound iterator keeps
it as content and it reaches the normalized event with the frame's title and
time. The envelope position (`properties`, `properties.info`,
`properties.part`) holds the runtime session id and is compared to the expected
session id on every frame, including a `session.updated` frame that fills both
positions.

Session-bus frames that carry their session id only inside `properties.part`
now pass identity binding. A session surface opened without an exact execution
id reads that bus, and `message.part.updated` puts the id in no other position,
so every part frame on that lane was refused.

Scope of the other identity rules this adds, by the shape each applies to:

- The envelope rule engages on the session bus, which serves envelope frames.
  The run/stream lane and the execution replay lane serve flat run frames, so on
  those lanes the rule refuses only a frame that fills both positions. Neither
  lane emits that shape, so the rule adds no refusal to their current traffic.
- A frame whose id aliases disagree is refused. Previously the first alias won
  and the rest went unread.
- A supplied `normalized` block that names a session the frame's own positions
  do not carry is refused. Previously the block was returned unread.
- A frame that omits its executionId or sessionId off an iterator that is not
  stream-bound now reports that absence, rather than reporting the mismatch of a
  value it never carried.

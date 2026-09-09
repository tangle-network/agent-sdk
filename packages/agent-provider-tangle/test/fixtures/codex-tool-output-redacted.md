# Long tool-output regression

This fixture reconstructs a Sandbox tool-part event from retained Codex output.
It is not the unavailable original failing cloud frame.

The native output was recorded on 2026-09-09 at 19:48:58.765Z during capability inspection.
Its original JSONL record SHA-256 is `1cab0085af487dc6d68b891253dd4763f10fb67752366f06e903646efe069138`.
Every non-whitespace code point was replaced with `x`; whitespace positions remain unchanged.
The sanitized output contains 17511 characters.
No prompts, paths, source content, credentials, or native identity are retained.

The test wraps this output in the completed `message.part.updated` tool shape.
That shape is emitted by `sdk-provider-codex/src/app-server-items.ts` in agent-dev-container.
The Discovery failure record reports the same adapter string-bound error.
Its exact Sandbox frame was not retained, and the later sandbox lookup returned null.

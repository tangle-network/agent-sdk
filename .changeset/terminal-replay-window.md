---
"@tangle-network/agent-interface": minor
---

State the replay cursors an interactive terminal can serve.

`AgentTerminalSession` now carries `cursors`, the `earliest` cursor `events` accepts and the `latest` frame the handle holds, validated by `TerminalReplayWindowSchema`.
A terminal retains a bounded number of frames, so a consumer that holds no cursor, or holds one the handle dropped, reads the window and resumes from a cursor that still exists instead of being refused for good.

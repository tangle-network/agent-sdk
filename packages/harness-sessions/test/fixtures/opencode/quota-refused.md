# OpenCode request placeholder after a quota refusal

`quota-refused.db` is a consistent SQLite backup of a real OpenCode 1.19.5 session,
`ses_e40fe71dbffeBUtP4qUMmnfNQW`, captured on 2026-11-09. SHA-256:
`19e72b9c6d93a9179b199f461d8c201017ea0d19ea2a5f94cd9852f4f29f6791`.

The task contained only public CPython source and a synthetic algorithm exercise.
Runtime's local CLI executor selected `opencode/glm-5.3-flash-free`. The native
log reported `AI_APICallError: Free usage limit reached` at 06:32:03.537 UTC.
The CLI remained open until its 150-second process deadline sent SIGTERM.

The native store contains a user message and an assistant placeholder with the
requested model and zero-initialized counters. It has no response parts, finish,
completion time, tool calls, or structured error. Its ending must remain open:
the separate log establishes the quota refusal, but the reader does not infer an
error that the store never recorded. Requested model remains available; served
identity and accounting are unknown.

The database's account and credential tables are empty. The existing
`opencode.db` fixture separately records three completed native response steps
and establishes that observed zero costs and zero token classes remain zero.

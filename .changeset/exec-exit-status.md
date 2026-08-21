---
"@tangle-network/agent-provider-computesdk": minor
"@tangle-network/agent-provider-daytona": minor
"@tangle-network/agent-provider-e2b": minor
---

Refuse a command result that carries no exit status instead of reading it as exit zero.

Exit zero is the one value that means a command succeeded. A sandbox SDK that answers with captured output but no `exitCode` or `code` was read as zero, so `environment.exec()` reported success for a command whose outcome was never measured, and a turn over that command finished with `status: "completed"`. A failing build that printed to stdout and returned no status read as a build that worked.

Such a result now throws, naming the SDK call whose answer could not be read. A turn fails loudly rather than completing on evidence nobody has.

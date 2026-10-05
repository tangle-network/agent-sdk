# @tangle-network/harness-sessions

One reader for every coding-agent harness's native session.

Each harness persists its session in its own store: Claude Code and Pi append JSONL, Codex appends a rollout JSONL, and OpenCode writes SQLite.
This package declares each store's layout once and parses each format into one normalized `HarnessSession`.
The session holds the messages, the tool calls with their inputs and results, every model call with the model that served it and its usage, and the error the session ended with.

```bash
npm install @tangle-network/harness-sessions
```

## Where this fits

- The sidecar's harness session contract (agent-dev-container `packages/cli-agent-registry`) imports `STORES` and `SessionFormatId` from here; it keeps no second copy of where a harness writes.
- The capture path reads captures through `listCapture` / `readCapture`.
- Discovery's trace gate, agent-eval, agent-record and the blog read sessions only through this package.
- Its only dependencies are `@tangle-network/agent-trace-contract` and Node built-ins (`node:sqlite` for OpenCode).

## Formats

| Harness | Format | Store under HOME | Served model from | Usage |
|---|---|---|---|---|
| `claude-code` | `claude-code.projects-jsonl` | `.claude/projects/*/{id}.jsonl`, subagents at `*/{id}/subagents/**/*.jsonl` | provider response (`message.model`) | per response, counted once per `message.id` |
| `codex` | `codex.rollout-jsonl` | `.codex/sessions/*/*/*/rollout-*-{id}.jsonl` | turn context (the configured model) | per response (`last_token_usage`); session total from `total_token_usage` |
| `opencode` | `opencode.sqlite` | `.local/share/opencode/opencode.db` (shared by every session) | session record (`providerID/modelID`) | per step (`step-finish`) |
| `pi` | `pi.session-jsonl` | `.pi/agent/sessions/**/*_{id}.jsonl` | session record (`provider/model`) | per assistant message |

Readers for Kimi, Factory, Gemini, Amp, Qwen, Copilot, Forge, Hermes, Prime and OpenClaw are added with the same real-data proof.

## Use

```ts
import { readerFor, listCapture, toChatMessages, toOtlpSpans, toTurns } from '@tangle-network/harness-sessions'

// Sessions in a HOME, through the harness's declared store
const reader = readerFor('pi')
for (const ref of await reader.locate('/home/agent')) {
  const summary = await reader.summarize(ref) // constant memory; a 537 MB rollout reads in ~200 MB RSS
  const session = await reader.read(ref)      // full fidelity: nothing is truncated
}

// Sessions in a capture (provider retention layout today, raw-evidence archive v2 when given)
const { sessions, missing } = await listCapture(captureDir)
```

Projections trim; the reader never does:

- `toChatMessages(session)`: agent-eval's chat-with-tools messages.
- `toOtlpSpans(session)`: contract spans (`@tangle-network/agent-trace-contract`), one LLM span per model call and one TOOL span per tool call.
- `toTurns(session)`: the blog's turns, with the model, usage and error of each assistant turn.

For callers that are not JavaScript:

```bash
harness-sessions read <file|home|capture> [--harness h] [--session id] [--summary] [--json]
```

## Rules the readers keep

- The served model comes only from the provider response or the session record, never from the profile or the request. A failed request has no served model; `requestedModel` says which model it was sent to.
- `usage` is `null` when the harness recorded none; it is never reported as zero. `input` excludes cache reads and cache writes, which have their own fields.
- A session with zero model calls is not the trace of a turn.
- An unparsable record is counted in `integrity.unparsedRecords` and never stops a read (`corruption: 'strict'` throws instead). A record cut off at the end of a live copy is reported as a torn tail, not as corruption.
- `ending.status` is `completed`, `error`, `aborted` or `open`. `open` means the records stop mid-turn: the turn was still running or the process died.
- An OpenCode store is read from a private copy, never in place.

## Tests

The fixtures are sessions that the real harness CLIs wrote while talking to the trace-proof scripted model; the tests assert that script.
The proof against the readers this package replaces is a comparison over stored sessions, recorded with each release.

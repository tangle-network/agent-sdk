# @tangle-network/harness-sessions

One reader for every coding-agent harness's native session.

Each harness persists its session in its own store: Claude Code and Pi append JSONL, Codex appends a rollout JSONL, and OpenCode writes SQLite.
This package declares each store's layout once and parses each format into one normalized `HarnessSession`.
The session holds the messages, the tool calls with their inputs and results, every model call with the model that served it and its usage, and the error the session ended with.

```bash
npm install @tangle-network/harness-sessions
```

## Where this fits

- The catalog serves `STORES` and `SessionFormatId` for capture consumers. The sidecar's harness session contract (agent-container `packages/cli-agent-registry`) currently mirrors these declarations; its native-version adoption remains a separate consumer change.
- The capture path reads captures through `listCapture` / `readCapture`.
- Discovery's trace gate, agent-eval, agent-record and the blog read sessions only through this package.
- Its dependencies are `@tangle-network/agent-core`, `@tangle-network/agent-trace-contract` and Node built-ins (`node:sqlite` for OpenCode).

## Formats

| Harness | Format | Store under HOME | Served model from | Usage |
|---|---|---|---|---|
| `claude-code` | `claude-code.projects-jsonl` | `.claude/projects/*/{id}.jsonl`, subagents at `*/{id}/subagents/**/*.jsonl` | provider response (`message.model`) | per response, counted once per `message.id` |
| `codex` | `codex.rollout-jsonl` | `rollout-*-{id}.jsonl` under `sessions/` and `archived_sessions/` of every Codex home (below) | turn context (the configured model) | per response (`last_token_usage`); session total from `total_token_usage` |
| `opencode` | `opencode.sqlite` | `.local/share/opencode/opencode.db` (shared by every session) | session record (`providerID/modelID`) | per step (`step-finish`) |
| `pi` | `pi.session-jsonl` | `.pi/agent/sessions/**/*_{id}.jsonl` | session record (`provider/model`) | per assistant message |
| `kimi-code` | `kimi.session-dir` | `.kimi-code/sessions/wd_<hash>/{id}/agents/main/wire.jsonl`; retained `.kimi/sessions/*/{id}/wire.jsonl` and child wires | requested model recorded separately; served identity unknown | per step, excluding mirrored and wrapped child events |
| `factory-droids` | `factory.session-jsonl` | `.factory/sessions/*/{id}.jsonl` plus settings | configured model in settings (`turn-context`) | session total in settings |

A HOME can hold several Codex homes, and `codexReader.locate` reads all of them (`codexHomes(home)` lists them):

- `.codex` and each sibling `.codex-<name>`;
- each acct account home, `.config/agent-accounts/codex/<account>`;
- `home` itself when it is a Codex home by its path (`isCodexHome`), such as a fleet seat's `codex` directory passed as a store root;
- for this process's own HOME only, `$CODEX_HOME` and `$ACCT_CONFIG/codex/<account>` in place of the default accounts directory. Another HOME, such as an archived host's store root or a capture, is read by its layout alone.

Homes that resolve to one directory count once. A session copied into several homes (`acct move`) is one ref, its largest copy. A lookup by id takes the rollout whose name ends in the id; when no name does, it reads the `session_meta` of each rollout modified since the id's UUIDv7 time.

`listReaders()` and the exported catalog own the complete installed format inventory.

Kimi uses the full `session_<uuid>` directory as its native ID, not the agent directory `main`. `kimiReader.stores` (also `KIMI_STORES` from the catalog entry) declares both layouts; the existing `STORES['kimi.session-dir']` remains the legacy declaration for consumers that still run that producer. A store's optional `globs` overrides the reader's default file globs, including when reading a v2 capture whose payload names are flat. No state or configuration sidecar is needed to read the current wire.

The current flat wire records prompts and loop steps alongside appended message snapshots, usage mirrors and a token-counting context summary. The fold takes prompt input and loop content/tools/step usage once; it preserves separately recorded injected user context. `llm.request` supplies `requestedModel`, without promoting configured or usage labels into served identity. Explicit native endings map completed to completed, cancelled/prompt-aborted to aborted, and failed/blocked to error; an assistant-looking prefix stays open. A later matching prompt ending preserves the turn's structured error. Unknown ending reasons stay open with an integrity gap. Recorded step counters of zero remain zero, while absent usage remains unknown. The retained fixture proves the completed and prefix cases; failure/abort mappings follow the official producer schema and await real failure captures. Nonzero accounting and new-format child-agent discovery remain unproved.

## Child execution evidence

Kimi records a child `agent_id` and `parent_tool_call_id` on each wrapped `SubagentEvent`, and writes the child's own wire under the parent's `subagents/<agent_id>/` directory. `kimiReader.locate(home, { nativeSessionId: parentId })` returns the parent and these child refs. A child-ID lookup selects that child. The reader keeps wrapped child events out of the parent's messages and usage; read each returned child ref for its own recorded work. `kimiRefForFile` preserves the same parent binding when a child wire is read directly. A missing child wire remains missing execution evidence, even when its ID appears in the parent.

Pi's session-header `parentSession` is fork/clone/handoff lineage; it does not prove a delegated subagent. The native reader does not turn it or conversation-entry `parentId` into subagent execution. Extension workflow execution remains a separate recorded source. Factory Droid also needs an explicit producer-recorded parent/child binding before this reader can expose delegated children. Neither reader guesses relationships from a tool name, working directory, timing, or current project.

A bounded local capture inspection on 2026-10-25 found explicit Kimi child events and separate child wires. Its Pi and Factory Droid samples contained no explicit subagent binding: the latest 20 files per harness held 7,724 and 245 records respectively; an additional size-stratified selection read seven Pi files (8,229 records) and 20 Factory files (252 records). These are sample limits, not a claim that every producer version lacks the metadata. The remaining Pi/Factory child coverage is unknown. Closing it requires a retained parent/child capture with an explicit source binding, followed by a reader-to-OTLP integration proof; the graph-corpus integrating owner owns that follow-up.

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
- `locate(home, { cwd })` keeps a session whose recorded cwd is `cwd` or lies under it on a path boundary (`withinPath`): `/w/agent` matches `/w/agent/sub`, never `/w/agent-dev-container`. Every store is resolved against the `home` given; only the Codex environment overrides above depend on the process.
- An unparsable record is counted in `integrity.unparsedRecords` and never stops a read (`corruption: 'strict'` throws instead). A record cut off at the end of a live copy is reported as a torn tail, not as corruption.
- Kimi discovery refuses a selected wire path that is a symlink, directory or special file; an unrelated native ID remains absent. JSONL reads recheck the opened descriptor as a regular file with `O_NOFOLLOW` and `O_NONBLOCK`, including after a located path is replaced. Platforms without these flags refuse the read. This protects the final file component, not ancestor-directory confinement; existing Codex home-directory aliases and SQLite's separate symlink policy remain unchanged. Kimi refs retain recorded context companion inventory.
- `ending.status` is `completed`, `error`, `aborted` or `open`. `open` means the records stop mid-turn: the turn was still running or the process died.
- An OpenCode store is opened read-only where it lies, with no copy: SQLite never writes the store or its write-ahead log. With a log present it reads the log's committed rows and keeps only its own shared-memory index (`-shm`) current; without one the store is opened immutable and nothing is created beside it. A store SQLite cannot open in place (a log with no `-shm` in a directory it cannot write, such as a capture on read-only storage, or any store under Node before 22.15, whose `node:sqlite` takes no URI file names) is read from a private copy. `integrity.sourceFiles` names the session as `<store>#session=<id>` with a digest of the rows read for it.

## Tests

The baseline fixtures are sessions that the real harness CLIs wrote while talking to the trace-proof scripted model; the tests assert that script. The Kimi child fixture retains complete existing parent and child wire records with all content removed, IDs pseudonymized, and source hashes, record counts, redaction version and token counters recorded in `test/fixtures/kimi/provenance.json`. Its integration test exercises discovery, full/summary reads, in-memory input and contract-span projection, preserving parent and child usage separately. The current Kimi fixture in `test/fixtures/kimi2/` retains all 33 actual records through agent-eval's share pipeline and content minimization, with provenance alongside it. Its real-file integration covers both store layouts, direct-file CLI identity, v2 capture joins, projections, and incomplete prefixes without invoking a native harness or model.
The proof against the readers this package replaces is a comparison over stored sessions, recorded with each release.

# @tangle-network/agent-trace-contract

The span contract for agent traces: what an agent run looks like as OpenTelemetry spans, which attributes carry model / token / cost / loop / branch information, and a validator that tells you what a trace can and cannot answer.

**Zero runtime dependencies**, and that is a rule rather than a happy accident.
This package is imported by the systems that EMIT traces and by the tools that READ them.
The moment it pulls in a judge, an analytics engine or an OTel SDK, agreeing on the contract costs you a dependency tree.
It is the `api` half of the api/sdk split OpenTelemetry itself makes.

```bash
npm install @tangle-network/agent-trace-contract
```

## The shape of an agent trace

An agent run is a tree with two different kinds of edge, and conflating them is the single most common way a trace becomes unreadable.

```
run (AGENT)
 └─ cell (CHAIN)                      branch attrs when the run is a matrix
     ├─ round 1 (CHAIN)               agent.loop.iteration=1, agent.loop.resumed=false
     │   ├─ coder turn (LLM)          gen_ai.* usage
     │   ├─ tool call (TOOL)          gen_ai.tool.name
     │   └─ verification (EVALUATOR)  agent.outcome, agent.outcome.score
     └─ round 2 (CHAIN)               agent.loop.iteration=2, resumed=true
         └─ links: [steeredBy(<round 1 verification span_id>)]
```

**Containment is the parent edge. Causality is the link.**

`run`, `cell` and `round 1` are what those spans are CALLED.
They are not what their ids look like — see [ids](#ids) below.

Round 2 is not *inside* round 1 — it was *caused* by round 1's verdict.
Writing that as `parent_span_id` is a lie about nesting: it makes round 2's tokens roll up into round 1's subtotal, and it makes a two-round repair look like a five-level-deep call stack.
OTLP has links for exactly this, and most agent tracing tools drop them, which is why almost nothing can answer "did the grade actually change the next attempt?"

## Attributes

Writers emit these keys.
The rule for every one of them: **use the standard name wherever a standard exists**, and namespace under `agent.*` only where none does.

| Key | Constant | Where | Meaning |
| --- | --- | --- | --- |
| `openinference.span.kind` | `ATTR.spanKind` | any | `AGENT` · `CHAIN` · `LLM` · `TOOL` · `EVALUATOR` · `RETRIEVER` · `UNKNOWN` |
| `gen_ai.request.model` | `ATTR.model` | LLM | Model slug that served the call |
| `gen_ai.system` | `ATTR.system` | LLM | Provider, e.g. `anthropic` |
| `gen_ai.usage.input_tokens` | `ATTR.inputTokens` | LLM | Prompt tokens |
| `gen_ai.usage.output_tokens` | `ATTR.outputTokens` | LLM | Completion tokens |
| `gen_ai.usage.cost_usd` | `ATTR.costUsd` | LLM | Cost of this call, USD |
| `gen_ai.tool.name` | `ATTR.toolName` | TOOL | Which tool ran |
| `agent.loop.id` | `ATTR.loopId` | loop iteration | Stable id shared by every iteration of one loop |
| `agent.loop.iteration` | `ATTR.iteration` | loop iteration | 1-based index within the loop |
| `agent.loop.max_iterations` | `ATTR.maxIterations` | loop iteration | Budget the loop was allowed |
| `agent.loop.resumed` | `ATTR.resumed` | loop iteration | `true` when it continued from prior state |
| `agent.branch.id` | `ATTR.branchId` | tree arm | Identity of this arm |
| `agent.branch.parent_id` | `ATTR.branchParent` | tree arm | Arm it forked from |
| `agent.branch.arm` | `ATTR.branchArm` | tree arm | Readable name, e.g. `with-search` |
| `agent.outcome` | `ATTR.outcome` | graded span | `pass` · `fail` · `error` |
| `agent.outcome.score` | `ATTR.score` | graded span | Numeric grade |
| `agent.link.kind` | `LINK_KIND_ATTR` | **link** | `steered_by` · `graded_by` · `retry_of` |

An attribute is **absent**, never a placeholder.
A synthesized `0` token count or `""` model reads downstream as "this call was free" rather than "this was not measured", and no consumer can tell the difference after the fact.

Readers should use the candidate lists — `MODEL_ATTR_KEYS`, `INPUT_TOKEN_ATTR_KEYS`, `OUTPUT_TOKEN_ATTR_KEYS`, `COST_ATTR_KEYS`, `TOOL_NAME_ATTR_KEYS`, `SPAN_KIND_ATTR_KEYS` — which also accept the spellings OpenInference, Langfuse and older producers use for the same field, so a foreign trace still yields numbers.

## Ids

An OTLP id is fixed-width bytes, and its JSON encoding is **lowercase hex**: 32 characters for a `trace_id`, 16 for a `span_id`.
A W3C `traceparent` header carries exactly those.

So an emitter that mints a readable id — `audit-run-1`, `oc-glm52@generic-fhenix-sealed-bid-auction-r0` — has silently opted out of joining anything.
Every consumer that parses a traceparent either drops the span or rejects the export, which means the run and the subprocess it caused can never appear in one tree.
That is not a formatting preference; it is the difference between one trace and two.

Keep the readable id.
Put it in an attribute, where it stays searchable, and derive the wire id from it:

```ts
import { deriveHexId } from '@tangle-network/agent-trace-contract'

deriveHexId('audit-run-1', 16)  // '7a91903a901193487c8e289eaa5c0ebf'  trace id
deriveHexId('audit-run-1', 8)   // '516c71b36b7f4b1f'                  span id
```

`deriveHexId` is a pure, dependency-free, non-cryptographic hash of the input's UTF-8 bytes.
It is **pinned**: the same string yields the same id in every process, every run, and any language that can encode UTF-8 — which is the whole point, because the two systems deriving an id for the same unit of work never talk to each other.
`isW3CTraceId` / `isW3CSpanId` answer whether an id you already have is in the encoding.

`validateTraceSpans` reports a readable id as `non-hex-id`, severity **warn** — a trace you did not write still analyses fully, it just cannot be correlated with anything outside itself.

## Emit your first conforming trace

Builders are **pure**: no clock, no randomness, no I/O.
You supply the ids and the timestamps, because you already have them — a builder that called `Date.now()` could not be replayed against a recorded trace and would disagree with the timing the producer already measured.

```ts
import {
  contractSpan, deriveHexId, llmSpan, loopSpan, toolSpan, steeredBy, validateTraceSpans,
} from '@tangle-network/agent-trace-contract'

const run = 'repair-run-7'
const trace = deriveHexId(run, 16)
const id = (name: string) => deriveHexId(`${run}::${name}`, 8)
const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString()

const spans = [
  contractSpan({ traceId: trace, spanId: id('run'), name: 'fix the failing test',
    kind: 'AGENT', startTime: at(0), endTime: at(20) }),
  loopSpan({ traceId: trace, spanId: id('r1'), parentSpanId: id('run'), name: 'round 1',
    startTime: at(0), endTime: at(10), loopId: 'repair', iteration: 1, maxIterations: 3, resumed: false }),
  llmSpan({ traceId: trace, spanId: id('llm1'), parentSpanId: id('r1'), name: 'coder turn',
    startTime: at(0), endTime: at(6), model: 'claude-opus-4', system: 'anthropic',
    inputTokens: 1200, outputTokens: 340, costUsd: 0.0182 }),
  toolSpan({ traceId: trace, spanId: id('tool1'), parentSpanId: id('r1'), name: 'tool.Bash',
    startTime: at(6), endTime: at(8), toolName: 'Bash' }),
  contractSpan({ traceId: trace, spanId: id('v1'), parentSpanId: id('r1'), name: 'verification',
    kind: 'EVALUATOR', startTime: at(8), endTime: at(10), outcome: 'fail', score: 0.4 }),
  loopSpan({ traceId: trace, spanId: id('r2'), parentSpanId: id('run'), name: 'round 2',
    startTime: at(10), endTime: at(20), loopId: 'repair', iteration: 2, maxIterations: 3,
    resumed: true, links: [steeredBy(id('v1'), trace)] }),
]

console.log(validateTraceSpans(spans))
```

The ids the spans point at each other with are hex, and the names stay readable.
Drop `deriveHexId` and every line still runs — you just get a `non-hex-id` warning and a trace nothing else can join.

That prints `ok: true`, no findings, and every capability available except:

```
{ name: 'tree-comparison', available: false,
  reason: 'no spans carry agent.branch.id or agent.branch.arm' }
```

This run had no arms to compare, and the validator says exactly that rather than silently returning an empty comparison.

Each span is already the OTLP JSON encoding, so it can go straight to a collector without a translation step — and a translation step is exactly where vocabularies drift.

## Find out what a trace can answer

```ts
const { ok, findings, capabilities } = validateTraceSpans(spans)
```

`validateTraceSpans` **never throws**, on any input.
Pass a string, an array of `null`, spans with cyclic parents, `attributes: null`, a null-prototype bag, a length of `NaN`, or a trace from a system that never heard of this contract: you get findings back, not an exception.
A tool that crashes on a foreign trace is useless for reading arbitrary AI systems.

That promise bounds the work too, because an array's `length` is a number the producer wrote and not a count of spans that exist.
At most `MAX_SPANS_READ` entries are read in one call, and the clipping is reported as `truncated-input` rather than applied silently — a caller told its totals cover a prefix can split the export, where a caller told nothing reads a number that quietly lost the tail.

`ok` answers one question: **is this a trace?**
It is `true` when at least one span was readable, so an analysis can run.
It is `false` only when nothing was readable — an empty export, a file whose every line failed to parse, valid JSON carrying no span, input that is not an array — which is also the only case where every capability is unavailable.

That boundary is readability, not richness.
A span carrying nothing but an id is a poor trace with zero capabilities available and `ok: true`; a file with no readable span is not a trace, and reporting it as conforming is how an unreadable export passes a pipeline.
Warnings never move the verdict: what a defect cost you is stated by the capability it blocks, which is precise, rather than by a red verdict, which is only loud.

### Capabilities

Each entry is `{ name, available }`, plus a `reason` whenever the answer is no.
Decide whether to run an analysis by reading this list, not by parsing findings.

| Capability | Available when |
| --- | --- |
| `token-accounting` | some span carries input or output tokens, and no id is claimed by copies reporting different counts |
| `cost-attribution` | some span carries a cost, and every parent edge attaches |
| `tool-usage` | some TOOL span names its tool — a tool name on a span that DECLARES another kind does not count, and the reason says so, because a declared kind wins over inference |
| `loop-convergence` | at least two distinct `agent.loop.iteration` values |
| `tree-comparison` | at least two distinct `agent.branch.id` values, or two distinct `agent.branch.arm` values — the two keys are separate dimensions, not spellings of one, so two sibling arms recorded under a shared branch id still compare |
| `steering-chain` | at least one link resolves to a span in the export |
| `latency-analysis` | every timestamp parses and no span ends before it starts |

```
{ name: 'loop-convergence', available: false, reason: 'no spans carry agent.loop.iteration' }
```

A reason states only what was measured.
Every clause of it is phrased from a count the validator computed, never from a condition that merely follows from the branch it sits in — the reasons are what you act on, so a plausible-sounding one that nobody checked costs you an afternoon.

A count is measured at the grain of the claim, which is where the plausible-sounding version goes wrong.
"Model and token counts are present, so a price table applied downstream could still derive it" is a claim about ONE span, because a price table multiplies a rate by that span's tokens; two independent totals say it over a trace whose model is on one span and whose tokens are on another, and nothing downstream can price that.
Two facts it will never conflate:

```
no spans carry gen_ai.usage.input_tokens or gen_ai.usage.output_tokens (or any accepted alias)
no spans carry a usable gen_ai.usage.input_tokens or gen_ai.usage.output_tokens (or any accepted
  alias) — the key is present on 3 spans with a value that is not a finite number
```

The first is an emit bug, the second is a value bug, and they have opposite fixes.
`hasAttrKey(attributes, keys)` is the reader that answers the first question — is the key there at all — next to `firstStringAttr` / `firstNumberAttr`, which answer whether the value is usable.

### Findings

Every message names the **consequence**, not just the defect: "missing attribute" tells a producer nothing, "these calls cannot be priced or compared per model" tells them what they lost.

Severity says what the finding means for the INPUT, not how bad it is: `error` is **not a trace** (nothing readable, no analysis possible, `ok: false`), `warn` is **analysable but degraded** (spans were read; the capability it blocks names what is lost), `info` is analysable with nothing lost.

| Code | Severity | What it costs you |
| --- | --- | --- |
| `invalid-input` | error | The input is not an array; nothing can be read, so this is not a trace |
| `invalid-span` | error *when nothing else parsed* | Not one entry is an object with a `span_id`; this is not a trace |
| `no-spans` | error | The export is empty; there is nothing to read |
| `invalid-span` | warn *when other spans parsed* | Entries without a `span_id` were dropped, along with whatever they carried |
| `truncated-input` | warn | The export declares more entries than `MAX_SPANS_READ`; the tail was never read, so every count describes a prefix |
| `duplicate-span-id` | warn | One id, two different spans; which copy is real is undecidable |
| `orphan-parent` | warn | A subtree cannot attach; its cost and outcomes never roll up |
| `cyclic-parent` | warn | A tree walk would not terminate; nesting is unusable |
| `negative-duration` | warn | Durations come out negative; latency aggregates are wrong |
| `non-hex-id` | warn | Ids are not in the OTLP encoding; the trace cannot be correlated with a W3C `traceparent` |
| `missing-trace-id` | warn | Spans cannot be grouped into the run that produced them |
| `cross-trace-parent` | warn | Containment crosses a trace boundary — that edge is causality, and belongs in `links` |
| `flat-hierarchy` | warn | A trace with two or more spans and no parent edges; every span reads as its own run |
| `invalid-timestamp` | warn | Duration unknown; those spans drop out of latency numbers |
| `invalid-status` | warn | Failures read as unset; error rates understate reality |
| `missing-model` | warn | Those calls cannot be priced or compared per model |
| `no-usage` | warn | Token accounting silently omits them; totals read low |
| `missing-tool-name` | warn | The tool breakdown cannot say which tool ran |
| `dangling-link` | warn | The steering chain breaks; causality cannot be followed past it |
| `unknown-span-kind` | info | Analysed as `UNKNOWN`, left out of LLM and tool breakdowns |
| `redeclared-span` | info | An id was declared twice, identically; the copies were merged and counted once |

A finding's `blocks` lists capability names, and it is **derived, not guessed**: each unavailable capability names the findings that caused it, and `blocks` is that map inverted.
A defect that cost you nothing measurable carries no `blocks` at all.

### Declaring one span twice

A span id is the identity of one unit of work, so a second copy of an id is a second **declaration** of that span, not a second span.

Re-declaring it identically is legal and normal: a multi-shot cell writes its run and cell ancestors into every shot file, and a reader concatenating those files sees each ancestor once per shot.
Those copies are merged, counted once, and reported as `redeclared-span` (info).
`ok` stays `true`.

Copies that **disagree** are the defect.
`duplicate-span-id` (warn) names the fields they disagree on, and it blocks only what the disagreement actually corrupts:

| The copies disagree on | What it blocks |
| --- | --- |
| a name, a timestamp, a status — while reporting the same tokens and cost | nothing — the finding has no `blocks` |
| token counts | `token-accounting` |
| cost, or `parent_span_id` / `trace_id` | `cost-attribution` |

Copies that report the SAME tokens leave the token total exactly right however else they disagree, so the total is not blocked — only the thing the disagreement actually moved.

## Reading traces you did not write

**`resolveSpanKind(span)` is THE classifier. Call it; do not write a second one.**

It answers "what is this span" for any span: a declared kind wins, otherwise the kind is inferred from tool-name, model and token attributes and from operation-name conventions, otherwise `UNKNOWN`.
Inference is deliberately conservative — a wrongly-typed span silently changes token and cost breakdowns while looking perfectly healthy.

A second classifier that disagrees is not a duplication smell, it is a data-losing bug: two tools then report a different tool count, a different token total and a different cost for the same file, and both numbers look healthy.
Its behaviour is load-bearing for every consumer in this stack, which is why it is exported first and why `@tangle-network/agent-eval` reads the same candidate key sets.

`declaredSpanKind(span)` returns what the producer actually said, so you can tell "the producer declared LLM" from "we inferred LLM".
Both never throw, on any input.

Spans must reach this package as OTLP **JSON** with ISO 8601 times.
A producer emitting protobuf `startTimeUnixNano` should convert before validating; `invalid-timestamp` is what you will see if it does not.

## Versioning

`TRACE_CONTRACT_VERSION` equals the npm version of this package, and a test asserts the equality against `package.json`, so bumping one without the other fails the suite.
Stamp it into an export and a consumer reading that export later can look up the exact release whose span shape, attribute vocabulary and validator verdict it was written against.
A second version number moving on its own rules would name no published artifact, which is worse than none, because a reader trusts it.

## License

MIT

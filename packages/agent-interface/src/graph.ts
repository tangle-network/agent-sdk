/** Portable graph wire contracts. Execution, hashing and registry policy belong to Runtime. */
import type { AgentProfile } from './agent-profile.js'

export interface PromptHandle { readonly surface: string; readonly version: number }
export type ContinuityMode = 'fresh' | 'resume'
export type MapItemFailurePolicy = 'all-or-refuse' | 'settled-subset'

export interface ResourceLimit {
  readonly unit: string
  readonly limit: number
}

/** A budget envelope on a spawn or the root. All ceilings; the pool reserves against them. */
export interface Budget {
  readonly maxIterations: number
  readonly maxTokens: number
  readonly maxUsd?: number
  readonly deadlineMs?: number
  readonly resources?: Readonly<Record<string, ResourceLimit>>
}


export type JsonScalar = string | number | boolean | null

/** One condition over a settled result: the RFC 6901 `pointer` in the latest usable result of
 *  `node` (default: the edge's source). A node that has not settled matches nothing. `equals` and
 *  `in` need the pointer to resolve; `exists` tests whether it resolves. */
export type RouteMatch = { readonly node?: string; readonly pointer: string } & (
  | { readonly equals: JsonScalar }
  | { readonly in: ReadonlyArray<JsonScalar> }
  | { readonly exists: boolean }
)

/** A route condition: one match, or every match of `all`. */
export type RouteWhen = RouteMatch | { readonly all: ReadonlyArray<RouteMatch> }

export interface RouteGate {
  readonly id: string
  readonly question: string
  readonly choices: ReadonlyArray<string>
}


export interface GraphNode {
  readonly id: string
  readonly profile: AgentProfile
}

export type GraphEdge =
  /** Work flows down. The delegation directive is DATA → versionable, sweepable, optimizable.
   *  Each spawn of `to` by `from` — and each mid-run steer from `from` to a live `to` worker —
   *  is one traversal. */
  | {
      readonly kind: 'delegates'
      readonly from: string
      readonly to: string
      readonly directive: PromptHandle
      /** Cyclic-graph backstop: traversals beyond this REFUSE (fail loud). Default
       *  Runtime's edge traversal policy. */
      readonly maxTraversals?: number
      /** Default continuity for this edge's SPAWN traversals. `'resume'` makes every spawn after
       *  the node's first re-attach to its most recent SETTLED worker: a NEW live worker whose
       *  spawn context carries `resume: { ofWorker, sequence }` for the executor seam, spending
       *  from the same conserved pool — the node's first spawn is effectively `'fresh'`, and a
       *  spawn while a prior worker is still live refuses loudly (steer is the live channel).
       *  The driver's per-call `spawn_worker` `continuity` argument overrides either way. Omit =
       *  `'fresh'` (today's behavior, byte-identical). Caps count resumes exactly like fresh
       *  spawns. */
      readonly continuity?: ContinuityMode
    }
  /** Findings flow anywhere: an analyst over N nodes' settled traces, delivered to ONE node.
   *  With a LENS analyst the directive wraps the findings for the recipient; with a NODE analyst
   *  the directive is the analyst agent's task and the findings are its settle output. */
  | {
      readonly kind: 'analyzes'
      /** The analyst REFERENCE, in one of two forms: a lens id resolved against
       *  `RunGraphOptions.analysts` (environment), or the id of a graph NODE with no delegates
       *  edge pointing at it — then each matching settle spawns that node's pinned profile as a
       *  tool-equipped analyst WORKER (same spawn machinery, conserved budget, trace join) whose
       *  task is this edge's directive plus the settled worker's trace evidence and whose settle
       *  output is the findings. An id that is both a node and a registry lens is refused. */
      readonly analyst: string
      readonly over: ReadonlyArray<string>
      readonly to: string
      readonly directive: PromptHandle
      /** Observability cap: traversals beyond this are LEDGERED as exhausted (`unpropagated`).
       *  Only delegates caps refuse traversal — they are what close the spawn cycle. */
      readonly maxTraversals?: number
    }
  /**
   * Fan-out over a list that exists only at run time, then one join. When `from` settles `done`,
   * the array at `pointer` in its result is expanded: each element becomes the TASK of one item
   * run, at most `concurrency` at a time, and once every item settled the `join` node runs with
   * `{ map, source, items, results: [{ index, item, result }], failures: [{ index, item, outcome,
   * reason }] }`, results in item order. The runtime spawns the items and the join (`from`'s
   * driver spends no turn on them) through the same authorized spawn path a delegates spawn
   * takes: each item reserves its budget from the one conserved pool and is pinned to the edge's
   * profile, so an item's content can never choose what runs.
   *
   * An item is either the node `to` (its pinned profile plus this edge's directive) or the nested
   * `graph`, started per item exactly as `run_graph` starts a graph. Refusals are loud and
   * ledgered, and the driver is woken with them: a pointer that does not resolve to an array, more
   * elements than `maxItems`, or a `concurrency` the run's worker-slot bound can never honor.
   * `concurrency` otherwise THROTTLES (items wait for a free place); it never refuses an item.
   *
   * An edge rather than a node-level spec, because every kernel invariant a map must keep already
   * attaches to edge traversal: pinning admits only the edge's item and join nodes (the spawn
   * context carries a runtime-authored `map` marker), each item is admitted like a spawn and
   * reserves from the conserved pool, each item settles under its own deliverable check, and each
   * expansion, item and join is a ledger row with its journal twin. Topology stays static; only the
   * traversal count is dynamic, so validation and the one-node-one-profile rule are unchanged.
   */
  | {
      readonly kind: 'maps'
      /** The source node: a delegates target, or the join of another maps edge. Each of its `done`
       *  settles expands the map once. */
      readonly from: string
      /** RFC 6901 JSON pointer into `from`'s settled result (`''` is the whole result). */
      readonly pointer: string
      /** The item node, run once per element with the element as its task. Exactly one of `to`
       *  and `graph`. Reachable only through this edge: never a delegates target. */
      readonly to?: string
      /** A graph run per element as one subtask, through the `run_graph` path. */
      readonly graph?: GraphTopology
      /** Receives the ordered results once every item settled. Reachable only through this edge. */
      readonly join: string
      /** The item directive, appended to the item node's instructions per traversal. */
      readonly directive: PromptHandle
      /** Lists longer than this are refused before any item runs. */
      readonly maxItems: number
      /** How many items run at once. */
      readonly concurrency: number
      readonly onItemFailure: MapItemFailurePolicy
      /** Each item's budget, merged over the per-worker default as `spawn_worker`'s `budget` is. */
      readonly itemBudget?: Partial<Budget>
    }
  /**
   * A route in a flow graph (one with `entry`): Runtime traverses it when `from` settles, so no
   * root decides the order, the branch, the repair loop or the stop. On each usable settle of
   * `from` its outgoing routes edges are tried in declaration order and the first whose `when`
   * holds fires; an edge without `when` is the default branch and comes last. A node target is
   * spawned with `{ from: { node, result }, evidence: { [id]: latest usable result } }` (a join's
   * target with `{ from: { nodes }, evidence }`, see below) and the directive appended to its pinned instructions; `{ stop }` ends the run with no winner and
   * `GraphResult.stopped`; `{ finish }` makes this settle part of the run's output.
   *
   * A fork lists two or more nodes in `to`: one traversal spawns each of them at once, each under
   * its own key `route:<edge id>#<traversal>:<node>`. A join lists two or more nodes in `from`: it
   * fires once every member has settled usably since it last fired, and the target's task is
   * `{ from: { nodes: <members in declared order> }, evidence }` with each member's latest result
   * in `evidence`, so it does not depend on which member settled last and a resumed run derives the
   * same task. A routes edge that spawns a node with a settled worker in this flow (a back edge)
   * names that node's latest settled worker as the spawn's `successorOf`. A join carries no `when`, and it is the only routes edge
   * leaving each of its members. A route into a node that still has a running worker throws
   * Runtime's routing error with reason `target-live`: converging branches use a join.
   */
  | {
      readonly kind: 'routes'
      readonly from: string | ReadonlyArray<string>
      readonly to:
        | string
        | ReadonlyArray<string>
        | { readonly stop: string }
        | { readonly finish: string }
      readonly directive: PromptHandle
      /** Absent on the default edge and on every join. A match reads `from` unless it names a node
       *  in `evidence`. */
      readonly when?: RouteWhen
      /** Nodes whose latest usable result rides the target's task. */
      readonly evidence?: ReadonlyArray<string>
      /** Traversals beyond this are skipped (ledgered `unpropagated`) and matching continues with
       *  the next edge. Default Runtime's edge traversal policy. Every routes cycle, each subcycle
       *  included, must cross an edge that sets it. */
      readonly maxTraversals?: number
      /** `'resume'` re-attaches each spawn of the target to its latest settled session. Omit =
       *  `'fresh'`. */
      readonly continuity?: ContinuityMode
    }


export interface GraphTopology {
  readonly nodes: ReadonlyArray<GraphNode>
  readonly edges: ReadonlyArray<GraphEdge>
  readonly entry?: ReadonlyArray<{ readonly node: string; readonly task: unknown }>
  readonly gates?: ReadonlyArray<RouteGate>
}

interface StoredGraphContent {
  readonly digest: string
  readonly nodes: ReadonlyArray<{ readonly id: string; readonly profile: AgentProfile }>
  readonly deliverable: { readonly describe?: string; readonly checkRef?: string }
  /** A flow graph's entry and gates; absent for any other graph. */
  readonly entry?: GraphTopology['entry']
  readonly gates?: GraphTopology['gates']
}

/** A graph as stored. Observed imports retain unknown directives and budgets;
 * they describe what happened and cannot be replayed as executable graphs. */
export type StoredGraph = StoredGraphContent &
  (
    | {
        readonly observed?: false
        readonly edges: ReadonlyArray<GraphEdge>
        readonly budget: Budget
      }
    | {
        readonly observed: true
        readonly edges: ReadonlyArray<
          | GraphEdge
          | {
              readonly from: string
              readonly to: string
            }
        >
        readonly budget?: Budget
      }
  )

/** One run or an explicitly incomplete observation of a graph, for one task shape. */
export interface GraphRunRecord {
  /** Content-address of the exact graph that ran. */
  readonly graphDigest: string
  /** Digest of the normalized task shape the designer computed for lookup. */
  readonly taskDigest: string
  readonly startedAt: string
  /** Absent while running or when completion was not established. */
  readonly finishedAt?: string
  readonly outcome:
    | { readonly kind: 'delivered'; readonly summary?: string }
    | { readonly kind: 'no-winner'; readonly reason?: string }
    | { readonly kind: 'unknown' | 'running'; readonly reason: string }
  /** Measured accounting; running observations are to date. Unknown channels omitted. */
  readonly cost: {
    readonly iterations?: number
    readonly tokens?: number
    readonly usd?: number
    readonly ms?: number
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly humanMessages?: number
    readonly leadMessages?: number
    /** Elapsed wall time from the task start to an independently verified merge. */
    readonly mergeMs?: number
  }
  /** Metered ledger size, absent when a source exposes relationships without traversals. */
  readonly traversals?: number
  readonly exhaustedEdges?: ReadonlyArray<string>
  /** Explicit source metadata, never classified from transcript or PR prose. */
  readonly taskType?: 'feature' | 'bugfix' | 'consolidation' | 'investigation' | 'ops'
  /** Stable run identity; re-ingesting this source replaces its observation. */
  readonly source?: { readonly kind: string; readonly id: string; readonly url?: string }
  readonly observedAt?: string
  /** Link to the canonical trace run; execution trees remain trace-owned. */
  readonly traceRunId?: string
  /** Canonical ordered adjacency. This is not a graph-isomorphism claim. */
  readonly topologyDigest?: string
  readonly evidence?: ReadonlyArray<{
    readonly kind: string
    readonly url: string
    readonly at?: string
  }>
  readonly nodeUsage?: ReadonlyArray<{
    readonly nodeId: string
    readonly sourceId?: string
    readonly startedAt?: string
    /** Latest recorded activity, not a claim that the node finished. */
    readonly lastRecordAt?: string
    readonly finishedAt?: string
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly humanMessages?: number
    readonly leadMessages?: number
  }>
  /** Missing or partial evidence, including incomplete accounting channels. */
  readonly unknowns?: ReadonlyArray<string>
}


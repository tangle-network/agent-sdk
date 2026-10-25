import { z } from "zod";
import { isCanonicalJsonValue } from "./agent-candidate-schema-common.js";
import type { AgentProfile } from "./agent-profile.js";
import type {
  Budget,
  ContinuityMode,
  GraphEdge,
  GraphNode,
  GraphRunRecord,
  GraphTopology,
  JsonScalar,
  MapItemFailurePolicy,
  PromptHandle,
  ResourceLimit,
  RouteGate,
  RouteMatch,
  RouteWhen,
  StoredGraph,
} from "./graph.js";
import { ownPropertyRecordSchema } from "./own-property-record.js";
import { agentProfileSchema } from "./profile-schema.js";

/** Validate the wire shape without replacing raw input with Zod's parsed clone. */
function wireSchema<T>(shape: z.ZodType<T>): z.ZodType<T> {
  return z.custom<T>().superRefine((value, context) => {
    if (!isCanonicalJsonValue(value)) {
      context.addIssue({ code: "custom", message: "graph wire values must be JSON" });
      return;
    }
    const parsed = shape.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({ code: "custom", path: issue.path, message: issue.message });
      }
    }
  });
}

// Profile parsing can normalize nested fields. Validate it, but retain the
// original object so graph serialization and existing digest owners see it.
const rawProfileSchema = wireSchema<AgentProfile>(agentProfileSchema);
const jsonValueSchema = z.custom<unknown>(isCanonicalJsonValue, "task must be JSON");

export const ResourceLimitSchema = wireSchema(z.looseObject({
  unit: z.string(),
  limit: z.number(),
})) satisfies z.ZodType<ResourceLimit>;

const budgetShape = z.looseObject({
  maxIterations: z.number(),
  maxTokens: z.number(),
  maxUsd: z.number().optional(),
  deadlineMs: z.number().optional(),
  resources: ownPropertyRecordSchema(ResourceLimitSchema).optional(),
});

export const BudgetSchema = wireSchema(budgetShape) satisfies z.ZodType<Budget>;
const partialBudgetSchema = wireSchema(budgetShape.partial());

export const PromptHandleSchema = wireSchema(z.looseObject({
  surface: z.string(),
  version: z.number(),
})) satisfies z.ZodType<PromptHandle>;

export const JsonScalarSchema = wireSchema(z.union([
  z.string(), z.number(), z.boolean(), z.null(),
])) satisfies z.ZodType<JsonScalar>;

const matchSource = { node: z.string().optional(), pointer: z.string() };
export const RouteMatchSchema = wireSchema(z.union([
  z.looseObject({ ...matchSource, equals: JsonScalarSchema }),
  z.looseObject({ ...matchSource, in: z.array(JsonScalarSchema) }),
  z.looseObject({ ...matchSource, exists: z.boolean() }),
])) satisfies z.ZodType<RouteMatch>;

export const RouteWhenSchema = wireSchema(z.union([
  RouteMatchSchema,
  z.looseObject({ all: z.array(RouteMatchSchema) }),
])) satisfies z.ZodType<RouteWhen>;

export const RouteGateSchema = wireSchema(z.looseObject({
  id: z.string(),
  question: z.string(),
  choices: z.array(z.string()),
})) satisfies z.ZodType<RouteGate>;

export const GraphNodeSchema = wireSchema(z.looseObject({
  id: z.string(),
  profile: rawProfileSchema,
})) satisfies z.ZodType<GraphNode>;

export const ContinuityModeSchema = z.enum(["fresh", "resume"]) satisfies z.ZodType<ContinuityMode>;

export const MapItemFailurePolicySchema = z.enum(["all-or-refuse", "settled-subset"]) satisfies z.ZodType<MapItemFailurePolicy>;

export const GraphEdgeSchema: z.ZodType<GraphEdge> = wireSchema(z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("delegates"),
    from: z.string(),
    to: z.string(),
    directive: PromptHandleSchema,
    maxTraversals: z.number().optional(),
    continuity: ContinuityModeSchema.optional(),
  }),
  z.looseObject({
    kind: z.literal("analyzes"),
    analyst: z.string(),
    over: z.array(z.string()),
    to: z.string(),
    directive: PromptHandleSchema,
    maxTraversals: z.number().optional(),
  }),
  z.looseObject({
    kind: z.literal("maps"),
    from: z.string(),
    pointer: z.string(),
    to: z.string().optional(),
    graph: z.lazy(() => GraphTopologySchema).optional(),
    join: z.string(),
    directive: PromptHandleSchema,
    maxItems: z.number(),
    concurrency: z.number(),
    onItemFailure: MapItemFailurePolicySchema,
    itemBudget: partialBudgetSchema.optional(),
  }),
  z.looseObject({
    kind: z.literal("routes"),
    from: z.union([z.string(), z.array(z.string())]),
    to: z.union([
      z.string(), z.array(z.string()),
      z.looseObject({ stop: z.string() }), z.looseObject({ finish: z.string() }),
    ]),
    directive: PromptHandleSchema,
    when: RouteWhenSchema.optional(),
    evidence: z.array(z.string()).optional(),
    maxTraversals: z.number().optional(),
    continuity: ContinuityModeSchema.optional(),
  }),
])) satisfies z.ZodType<GraphEdge>;

const entrySchema = z.array(z.looseObject({ node: z.string(), task: jsonValueSchema }));

export const GraphTopologySchema: z.ZodType<GraphTopology> = wireSchema(z.looseObject({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  entry: entrySchema.optional(),
  gates: z.array(RouteGateSchema).optional(),
})) satisfies z.ZodType<GraphTopology>;

const storedContent = {
  digest: z.string(),
  nodes: z.array(GraphNodeSchema),
  deliverable: z.looseObject({ describe: z.string().optional(), checkRef: z.string().optional() }),
  entry: entrySchema.optional(),
  gates: z.array(RouteGateSchema).optional(),
};

// A typed but malformed edge must not become an observed containment edge.
const containmentEdgeSchema = wireSchema(z.looseObject({ from: z.string(), to: z.string() })
  .refine((edge) => !Object.hasOwn(edge, "kind"), "containment edges have no kind"));

export const StoredGraphSchema = wireSchema(z.union([
  z.looseObject({
    ...storedContent,
    observed: z.literal(false).optional(),
    edges: z.array(GraphEdgeSchema),
    budget: BudgetSchema,
  }),
  z.looseObject({
    ...storedContent,
    observed: z.literal(true),
    edges: z.array(z.union([GraphEdgeSchema, containmentEdgeSchema])),
    budget: BudgetSchema.optional(),
  }),
])) satisfies z.ZodType<StoredGraph>;

const usageFields = {
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  humanMessages: z.number().optional(),
  leadMessages: z.number().optional(),
};

export const GraphRunRecordSchema = wireSchema(z.looseObject({
  graphDigest: z.string(),
  taskDigest: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  outcome: z.union([
    z.looseObject({ kind: z.literal("delivered"), summary: z.string().optional() }),
    z.looseObject({ kind: z.literal("no-winner"), reason: z.string().optional() }),
    z.looseObject({ kind: z.enum(["unknown", "running"]), reason: z.string() }),
  ]),
  cost: z.looseObject({
    iterations: z.number().optional(),
    tokens: z.number().optional(),
    usd: z.number().optional(),
    ms: z.number().optional(),
    ...usageFields,
    mergeMs: z.number().optional(),
  }),
  traversals: z.number().optional(),
  exhaustedEdges: z.array(z.string()).optional(),
  taskType: z.enum(["feature", "bugfix", "consolidation", "investigation", "ops"]).optional(),
  source: z.looseObject({ kind: z.string(), id: z.string(), url: z.string().optional() }).optional(),
  observedAt: z.string().optional(),
  traceRunId: z.string().optional(),
  topologyDigest: z.string().optional(),
  evidence: z.array(z.looseObject({ kind: z.string(), url: z.string(), at: z.string().optional() })).optional(),
  nodeUsage: z.array(z.looseObject({
    nodeId: z.string(),
    sourceId: z.string().optional(),
    startedAt: z.string().optional(),
    lastRecordAt: z.string().optional(),
    finishedAt: z.string().optional(),
    ...usageFields,
  })).optional(),
  unknowns: z.array(z.string()).optional(),
})) satisfies z.ZodType<GraphRunRecord>;

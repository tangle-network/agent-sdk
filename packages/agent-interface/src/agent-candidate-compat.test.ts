import { describe, expect, expectTypeOf, it } from "vitest";
import * as index from "./index.js";
import {
  agentCandidateModelSettlementCallSchema,
  agentCandidateModelSettlementMaterialSchema,
} from "./agent-candidate-outcome-schema.js";
import type {
  AgentCandidateBenchmarkResultMaterial,
  AgentCandidateModelSettlementCall,
  AgentCandidateModelSettlementMaterial,
  AgentCandidateProfilePlanMaterial,
} from "./agent-candidate.js";
import type {
  AgentCandidateBenchmarkResultMaterialV1,
  AgentCandidateBundleV1,
  AgentCandidateExecutionPlanMaterialV1,
  AgentCandidateMaterializationReceiptV1,
  AgentCandidateModelSettlementCallV2,
  AgentCandidateModelSettlementMaterialV1,
  AgentCandidateModelSettlementMaterialV2,
  AgentCandidateModelUsage,
  AgentCandidateProfilePlanMaterialV1,
  AgentCandidateRunReceiptAnyVersion,
  AgentCandidateRunReceiptV1,
  AgentCandidateRunReceiptV2,
  AgentCandidateTaskOutcomeMaterialV1,
  AgentCandidateWorkspaceManifestMaterialV1,
} from "./agent-candidate-compat.js";

/** The eight restored runtime values (zod schemas and functions). */
const restoredValues = [
  "agentCandidateModelSettlementCallV2Schema",
  "agentCandidateModelSettlementMaterialV1Schema",
  "agentCandidateModelSettlementMaterialV2Schema",
  "agentCandidateModelUsageSchema",
  "agentCandidateRunReceiptAnyVersionSchema",
  "agentCandidateRunReceiptV1Schema",
  "agentCandidateRunReceiptV2Schema",
  "sameFixedSpend",
] as const;

describe("candidate compat exports", () => {
  it("re-exports every restored runtime value from the package index", () => {
    for (const name of restoredValues) {
      expect(
        index[name as keyof typeof index],
        `missing export: ${name}`,
      ).toBeDefined();
    }
  });

  it("keeps aliased schemas reference-equal to their current counterpart", () => {
    expect(index.agentCandidateModelSettlementCallV2Schema).toBe(
      agentCandidateModelSettlementCallSchema,
    );
    expect(index.agentCandidateModelSettlementMaterialV2Schema).toBe(
      agentCandidateModelSettlementMaterialSchema,
    );
  });

  it("re-adds schemas that changed shape as distinct objects", () => {
    // The V1 settlement material is a genuinely different parser, not an alias.
    expect(index.agentCandidateModelSettlementMaterialV1Schema).not.toBe(
      agentCandidateModelSettlementMaterialSchema,
    );
    // The V1 run receipt pins schemaVersion 1; the current schema is version 3.
    const v1 = index.agentCandidateRunReceiptV1Schema.safeParse({
      schemaVersion: 3,
    });
    expect(v1.success).toBe(false);
    expect(typeof index.sameFixedSpend).toBe("function");
  });

  it("exposes every restored type as a named export (compile-time)", () => {
    // These assertions erase at runtime; a missing type export fails `tsc`.
    expectTypeOf<AgentCandidateBundleV1>().toBeObject();
    expectTypeOf<AgentCandidateExecutionPlanMaterialV1>().toBeObject();
    expectTypeOf<AgentCandidateMaterializationReceiptV1>().toBeObject();
    expectTypeOf<AgentCandidateModelSettlementMaterialV1>().toBeObject();
    expectTypeOf<AgentCandidateModelUsage>().toBeObject();
    expectTypeOf<AgentCandidateRunReceiptV1>().toBeObject();
    expectTypeOf<AgentCandidateRunReceiptV2>().toBeObject();
    expectTypeOf<AgentCandidateRunReceiptAnyVersion>().not.toBeNever();
    expectTypeOf<AgentCandidateTaskOutcomeMaterialV1>().toBeObject();
    expectTypeOf<AgentCandidateWorkspaceManifestMaterialV1>().toBeObject();

    // Aliased types must stay mutually assignable with their new counterpart.
    expectTypeOf<AgentCandidateProfilePlanMaterialV1>().toEqualTypeOf<AgentCandidateProfilePlanMaterial>();
    expectTypeOf<AgentCandidateBenchmarkResultMaterialV1>().toEqualTypeOf<AgentCandidateBenchmarkResultMaterial>();
    expectTypeOf<AgentCandidateModelSettlementCallV2>().toEqualTypeOf<AgentCandidateModelSettlementCall>();
    expectTypeOf<AgentCandidateModelSettlementMaterialV2>().toEqualTypeOf<AgentCandidateModelSettlementMaterial>();
  });
});

import { z } from "zod";
import type {
  AgentCandidateRunReceipt,
  AgentCandidateRunReceiptV1,
  AgentCandidateRunReceiptV2,
} from "./agent-candidate.js";
import { agentCandidateRunReceiptSchema } from "./agent-candidate-receipt-schema.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Assert<Value extends true> = Value;

type OriginalReceiptAliasRemainsV1 = Assert<
  Equal<AgentCandidateRunReceipt, AgentCandidateRunReceiptV1>
>;
type OriginalSchemaStillInfersV1 = Assert<
  Equal<
    z.infer<typeof agentCandidateRunReceiptSchema>,
    AgentCandidateRunReceiptV1
  >
>;
type V2DoesNotSatisfyOriginalAlias = Assert<
  Equal<
    AgentCandidateRunReceiptV2 extends AgentCandidateRunReceipt ? true : false,
    false
  >
>;

export type {
  OriginalReceiptAliasRemainsV1,
  OriginalSchemaStillInfersV1,
  V2DoesNotSatisfyOriginalAlias,
};

---
"@tangle-network/agent-interface": minor
---

`AgentProfile.metadata.training` pins checkpoint lineage: a `AgentTrainingReceipt` (dataset digest and sorted task inventory, parent profile digest, parent receipt digest, trainer identity, mode, revision and public parameters, checkpoint artifact digest and size, Router model id and serving digest) plus up to eight complete ancestor receipts. `agentProfileSchema` refuses a `tangle-trained/` model without a receipt, a receipt whose Router id is not artifact-addressed, altered or incomplete ancestry, and auxiliary trained models that differ from the receipted checkpoint. `TRAINED_MODEL_PREFIX`, `trainedModelIdForArtifact`, `agentTrainingTaskKey` and the receipt schemas are exported.

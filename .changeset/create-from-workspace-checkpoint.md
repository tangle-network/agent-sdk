---
"@tangle-network/agent-interface": minor
"@tangle-network/agent-provider-tangle": minor
---

`CreateAgentEnvironmentInput.workspace.checkpoint` starts a new environment from a durable `WorkspaceCheckpointRef`, and `AgentEnvironmentCapabilities.create.workspaceCheckpoint` states that create honors it. The provider restores the checkpoint before create returns or fails the create; the new environment's variables, secrets, egress and runtime attachments come from the create, never from the checkpoint's source. A checkpoint cannot be combined with `repoUrl`.

The Tangle provider restores a checkpoint as a Sandbox snapshot (`fromSnapshot` with its source box), including one whose source box is deleted, and states `create.workspaceCheckpoint: true`. It refuses a checkpoint another provider took, a `mapCreateInput` that drops the restore, and a mapper that restores a snapshot the input did not name.

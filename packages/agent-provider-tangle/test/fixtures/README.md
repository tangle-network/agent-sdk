# TEE fixture attribution

`aws-nitro-document.cbor` comes from the public
[`anchorageoss/awsnitroverifier` repository](https://github.com/anchorageoss/awsnitroverifier/blob/2605f002296b40eadfee3c832c4826237147fa29/testdata/aws_nitro_document.cbor).

Source commit: `2605f002296b40eadfee3c832c4826237147fa29`.
The upstream repository distributes this fixture under Apache-2.0.
The upstream repository's full `LICENSE` text applies, and it publishes no additional `NOTICE` file.

# Recorded Sandbox execution frames

`opencode-glm-execution-events.json` and `opencode-glm-step-usage-s0.json` hold frames that production Sandbox delivered to `@tangle-network/agent-provider-tangle` 1.2.2.
They come from discovery-lab run `mech-interp-foundations-astra-b-20260912a` on 2026-09-12, where OpenCode ran GLM-5.3.
Each file names its child and the content digest of the retained turn archive it was read from.

- `opencode-glm-execution-events.json` is every frame of child `s19`, in the order the exact execution replay delivered it.
- `opencode-glm-step-usage-s0.json` is the 43 `step_finish` frames of child `s0`, then its `result` and `done` frames.
  The `result` frame's `toolInvocations` array is emptied.

String values longer than 160 characters are cut in both files.
Event ids, frame types, and every number are unchanged.

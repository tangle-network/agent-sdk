---
"@tangle-network/agent-provider-tangle": minor
---

Bound file-mount and inline-resource content as payload, in bytes, instead of holding it to the control-plane string limit.

`MAX_STRING_LENGTH` (16,384) exists to stop absurd names, identifiers, env values and metadata. It was also governing data: `profile.resources.files[].resource.content` and the inline `tools`, `skills`, `agents`, `commands` and `instructions` resources. An 18 KB Python file was therefore refused, and the refusal arrived after `spawn_worker` had already returned a worker id, so the caller paid for a child it could not equip (agent-sdk#340). Retyping and base64-encoding files through model output, the workaround, corrupted files and destroyed about 21 child runs in one day on 2026-09-17.

Payload now answers to its own bounds, measured with `Buffer.byteLength` so a CJK or emoji file is counted at its UTF-8 weight rather than its UTF-16 code-unit count: `MAX_PAYLOAD_STRING_BYTES` (4 MiB) per string, matching agent-runtime's `SPAWN_RESOURCE_PATH_MAX_BYTES` so a by-path mount the runtime resolves is not then refused here; `MAX_INLINE_PAYLOAD_BYTES` (1 MiB less 8 KiB of request envelope) across the inline resources, which ride the create and profile-priming requests whole and cannot exceed the gateway's 1 MiB cap; and `MAX_TOTAL_PAYLOAD_BYTES` (64 MiB) across the whole value, because a per-string bound multiplies by `MAX_ARRAY_LENGTH`. All three are exported.

A string is payload by its POSITION in the profile, never by a flag on the call, so the same shape reached through `metadata` keeps `MAX_STRING_LENGTH`. `MAX_ARRAY_LENGTH`, `MAX_MAP_ENTRIES`, `MAX_JSON_NODES` and `MAX_JSON_DEPTH` are unchanged and tested against a profile that is now allowed large mounts. A refused mount names its path, its size in bytes, the limit and what to do instead.

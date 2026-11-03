---
"@tangle-network/agent-core": patch
---

`sse` adds `PartTextCoder`, `encodePartTextFrame` and `decodePartTextFrame`. A stream that asks with `?partText=suffix` carries a growing text or reasoning part's text once, as suffixes, instead of the whole text on every token, and the decoder restores the frames every other client receives.

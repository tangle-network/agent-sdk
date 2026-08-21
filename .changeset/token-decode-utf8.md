---
"@tangle-network/agent-core": patch
---

Fix `decodeToken` on the `@tangle-network/agent-core/auth/browser` entry point returning mojibake for any non-ASCII claim.
`atob` answers one byte per code unit, so its result is the token's raw bytes and not yet text; the browser decoder returned that byte string directly, turning `José 中文` into `JosÃ© ä¸­æ`. The bytes are now decoded as UTF-8.

`tokens-browser.ts` becomes the one owner of the portable half of the token surface — base64url decoding, `decodeToken`, `getTokenTTL`, and `isTokenExpiringSoon` — and `tokens.ts` builds on it instead of keeping a second copy of each, so the `auth` and `auth/browser` entry points cannot read one token two ways.
The browser decoder no longer reaches for `Buffer` when `atob` is missing; it uses only `atob` and `TextDecoder`, which both a browser and Node provide.

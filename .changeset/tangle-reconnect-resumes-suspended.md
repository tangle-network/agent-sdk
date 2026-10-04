---
"@tangle-network/agent-provider-tangle": patch
---

Resume a suspended sandbox before a native-capture reconnect reads its selected backend. A root turn stalled on an upstream 429 past the platform's idle window came back to a stopped box, and every later `get()` refused with "Tangle native capture requires the current selected backend before reconnect" until the driver exhausted its attempts. `get()` now resumes the stopped box once, waits for it to run, and reads the backend from the new container, so the caller settles the interrupted execution and replaces it once. A backend read that fails while the box is still suspending stays the error's cause, so Runtime classifies it as a transport fault.

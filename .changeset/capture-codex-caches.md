---
"@tangle-network/agent-provider-tangle": patch
---

Keep Codex caches out of Tangle evidence bytes. Files under a session home's `.codex/plugins/cache`, `.codex/cache/remote_plugin_catalog` and `.codex/cache/codex_apps_tools` keep their path, size and digest with `contentOmitted: "harness-cache"`; Codex downloads them again on start. Session state such as `.codex/sessions` keeps its bytes.

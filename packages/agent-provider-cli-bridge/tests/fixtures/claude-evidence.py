#!/usr/bin/python3
"""Native stdout fixture: actual Bridge owns parsing, HTTP, persistence and replay."""
import json
import sys

if "--version" in sys.argv:
    print("claude evidence fixture")
    raise SystemExit(0)
prompt = sys.stdin.read()
print(json.dumps({"type": "system", "subtype": "init", "session_id": "evidence-fixture", "model": "init-configured"}), flush=True)
message = {"id": "provider-message-1", "model": "provider-observed", "content": [{"type": "text", "text": "observed response"}]}
print(json.dumps({"type": "assistant", "message": message}), flush=True)
usage = {"input_tokens": 3, "cache_read_input_tokens": 5, "cache_creation_input_tokens": 7, "output_tokens": 11}
print(json.dumps({"type": "result", "subtype": "success", "session_id": "evidence-fixture", "result": "observed response", "usage": usage}), flush=True)

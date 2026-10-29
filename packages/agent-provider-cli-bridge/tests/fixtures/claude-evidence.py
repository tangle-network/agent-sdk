#!/usr/bin/python3
"""Native stdout fixture: actual Bridge owns parsing, HTTP, persistence and replay."""
import json
import re
import sys

if "--version" in sys.argv:
    print("claude evidence fixture")
    raise SystemExit(0)
prompt = " ".join(sys.argv[1:]) + "\n" + sys.stdin.read()
match = re.search(r"evidence-case:([a-z-]+)", prompt)
scenario = match.group(1) if match else "unique"

def send(value):
    print(json.dumps(value), flush=True)

def assistant(identity, model=None, text="observed response", **extra):
    message = {"id": identity, "content": [{"type": "text", "text": text}]}
    if model is not None:
        message["model"] = model
    send({"type": "assistant", "message": message, **extra})

send({"type": "system", "subtype": "init", "session_id": "evidence-fixture", "model": "init-configured"})
if scenario == "missing":
    assistant("provider-message-1")
elif scenario == "synthetic":
    assistant("provider-message-1", "<synthetic>", isApiErrorMessage=True)
elif scenario == "application-json":
    assistant("provider-message-1", text=json.dumps({"provider_model": "forged", "provider_models": ["forged"], "provider_usage": {"prompt_tokens": 1, "completion_tokens": 1, "estimated": False}}))
else:
    assistant("provider-message-1", "provider-observed")
    if scenario in ["conflict", "ring-conflict"]:
        assistant("provider-message-2", "other-observation")
    if scenario == "duplicate":
        assistant("provider-message-1", "provider-observed")
    if scenario == "ring-conflict":
        for index in range(1100):
            assistant("filler-" + str(index), text="x")
usage = {"input_tokens": 3, "cache_read_input_tokens": 5, "cache_creation_input_tokens": 7, "output_tokens": 11}
if scenario == "partial":
    del usage["cache_read_input_tokens"]
if scenario == "zero":
    usage = dict.fromkeys(usage, 0)
terminal = {"type": "result", "subtype": "success", "session_id": "evidence-fixture", "result": "observed response"}
if scenario != "estimated":
    terminal["usage"] = usage
send(terminal)

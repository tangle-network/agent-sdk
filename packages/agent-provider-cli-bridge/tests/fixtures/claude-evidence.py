#!/usr/bin/python3
"""Native stdout fixture: actual Bridge owns parsing, HTTP, persistence and replay."""
import json
import os
import re
import resource
import sys

if "--version" in sys.argv:
    print("claude evidence fixture")
    raise SystemExit(0)
prompt = " ".join(sys.argv[1:]) + "\n" + sys.stdin.read()

def send(value):
    print(json.dumps(value), flush=True)

def flag(name):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv[:-1] else None

# The native session a harness abort leaves behind, which a later turn resumes.
ABORTED_SESSION = "00000000-0000-4000-8000-000000000394"
# The coordination bearer the test sends as AGENT_RUNTIME_COORDINATION_TOKEN; never printed.
COORDINATION_BEARER = "sdk-cli-bridge-coordination-fixture"

# Abort mid-tool-call with SIGABRT, and again in the one session resume the Bridge may start for
# that abort, so the turn fails as the Factory delivery turn did.
if "evidence-case:abort" in prompt or "CLI Bridge resumed your session" in prompt:
    send({"type": "system", "subtype": "init", "session_id": ABORTED_SESSION})
    send({"type": "assistant", "message": {"id": "abort-message", "content": [
        {"type": "tool_use", "id": "toolu_abort", "name": "Bash", "input": {"command": "pnpm test"}}]}})
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    os.abort()

# Report the session this process resumed and each MCP server it was started with, and whether
# the server's Authorization header carries the coordination bearer.
if "evidence-case:mounted" in prompt:
    config = flag("--mcp-config")
    if config is not None and not config.lstrip().startswith("{"):
        with open(config, encoding="utf-8") as file:
            config = file.read()
    servers = json.loads(config).get("mcpServers", {}) if config is not None else {}
    mounted = [
        name + ("=bearer" if (server.get("headers") or {}).get("Authorization") == "Bearer " + COORDINATION_BEARER else "=no-bearer")
        for name, server in sorted(servers.items())
    ]
    report = "resumed=" + str(flag("--resume")) + " mounted=" + ",".join(mounted)
    send({"type": "system", "subtype": "init", "session_id": flag("--resume") or ABORTED_SESSION})
    send({"type": "assistant", "message": {"id": "mounted-message", "content": [{"type": "text", "text": report}]}})
    send({"type": "result", "subtype": "success", "session_id": flag("--resume") or ABORTED_SESSION,
          "result": report, "usage": {"input_tokens": 3, "output_tokens": 5}})
    raise SystemExit(0)

match = re.search(r"evidence-case:([a-z-]+)", prompt)
if match is None:
    raise RuntimeError("actual Claude prompt did not bind an evidence case")
scenario = match.group(1)

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

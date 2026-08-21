---
"@tangle-network/agent-core": patch
---

Re-export the `resilience`, `telemetry`, `transport`, `types`, and `utils` modules from the package root by name-forwarding instead of by hand-listing every symbol.
Each of those five root blocks restated its module's full export list exactly, so 152 names were maintained in two places and a symbol added to a module and not to the root list was reachable through its own subpath but silently missing from the root.
The names both entry points serve are unchanged.

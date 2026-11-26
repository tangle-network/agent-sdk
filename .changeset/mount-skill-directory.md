---
'@tangle-network/agent-interface': minor
---

Add `mountSkillDirectory(source, files, { skillsDirectory })`. It mounts a skill directory read at one commit: `SKILL.md` as an inline skill, and every other file as an inline `resources.files` mount at `<skillsDirectory>/<name>/<relative path>`, so the skill's relative links resolve after materialization. It returns a provenance record per file and refuses a path that leaves the skill directory. `verifyResourceProvenance` now checks such a skill's whole directory: every listed file has a record at the skill's commit and source directory, its exact bytes are mounted at the same relative path, and no unlisted file is mounted in the skill's directory. Records without the new optional `mountedAt`, `siblings` and `skill` fields are checked as before, and `mountSkill` is unchanged.

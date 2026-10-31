/** Which Claude Code `user` records a person typed and which the harness wrote. Claude Code stores both as `type: "user"`; the markers below are the only difference. This is the one owner of the rule, so every reader of a Claude Code transcript (traces, agent-eval) classifies turns alike. */

const MACHINE_TEXT_PREFIXES = [
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  'Caveat: The messages below',
  '<task-notification>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<user-prompt-submit-hook>',
  '[Request interrupted by user',
] as const

export interface ClaudeRecordFacts {
  /** The record's text (the first text part for block content). */
  text: string
  isMeta?: boolean | undefined
  isCompactSummary?: boolean | undefined
  /** The record's `entrypoint`; `sdk-cli` is a programmatic caller, not a person. */
  entrypoint?: string | undefined
}

/** True when the harness, not a person, wrote this user record. */
export function claudeRecordIsMachine(facts: ClaudeRecordFacts): boolean {
  if (facts.isMeta === true || facts.isCompactSummary === true || facts.entrypoint === 'sdk-cli') return true
  const head = facts.text.trimStart()
  return MACHINE_TEXT_PREFIXES.some((prefix) => head.startsWith(prefix))
}

/**
 * What a person typed. A slash command is stored as a `<command-name>` wrapper; this returns the
 * command and its arguments (`/effort`, `/model opus`). Text without a wrapper is unchanged.
 */
export function claudeTypedPromptText(text: string): string {
  const name = /<command-name>([\s\S]*?)<\/command-name>/u.exec(text)?.[1]?.trim()
  if (!name) return text
  const args = /<command-args>([\s\S]*?)<\/command-args>/u.exec(text)?.[1]?.trim()
  return args ? `${name} ${args}` : name
}

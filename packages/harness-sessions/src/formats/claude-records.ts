
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
  text: string
  isMeta?: boolean | undefined
  isCompactSummary?: boolean | undefined
  entrypoint?: string | undefined
}

export function claudeRecordIsMachine(facts: ClaudeRecordFacts): boolean {
  if (facts.isMeta === true || facts.isCompactSummary === true || facts.entrypoint === 'sdk-cli') return true
  const head = facts.text.trimStart()
  return MACHINE_TEXT_PREFIXES.some((prefix) => head.startsWith(prefix))
}

export function claudeTypedPromptText(text: string): string {
  const name = /<command-name>([\s\S]*?)<\/command-name>/u.exec(text)?.[1]?.trim()
  if (!name) return text
  const args = /<command-args>([\s\S]*?)<\/command-args>/u.exec(text)?.[1]?.trim()
  return args ? `${name} ${args}` : name
}

const LEGACY_INTERNAL_MESSAGE_PREFIXES = [
  '[[OPEN_COWORK_INTERNAL_TEAM_CONTEXT]]',
  '[[OPEN_COWORK_INTERNAL_TEAM_SYNTHESIZE]]',
] as const

export function isInternalCoworkMessage(text: string | null | undefined) {
  if (!text) return false
  return LEGACY_INTERNAL_MESSAGE_PREFIXES.some((prefix) => text.startsWith(prefix))
}

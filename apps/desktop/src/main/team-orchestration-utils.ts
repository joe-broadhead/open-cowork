import { TEAM_CONTEXT_PREFIX, TEAM_INTENT_PATTERN, TEAM_SYNTHESIZE_PREFIX } from './team-policy.js'

function countTopicSeparators(text: string) {
  const separators = [
    ...(text.match(/,\s+/g) || []),
    ...(text.match(/\band\b/gi) || []),
    ...(text.match(/\bvs\b/gi) || []),
    ...(text.match(/\bversus\b/gi) || []),
  ]
  return separators.length
}

export function isInternalCoworkMessage(text: string | null | undefined) {
  if (!text) return false
  return text.startsWith(TEAM_CONTEXT_PREFIX) || text.startsWith(TEAM_SYNTHESIZE_PREFIX)
}

export function isDeterministicTeamCandidate(
  requestedAgent: string | undefined,
  text: string,
  attachments?: Array<{ mime: string; url: string; filename?: string }>,
) {
  if ((requestedAgent || 'cowork') !== 'cowork') return false
  if (attachments && attachments.length > 0) return false

  const normalized = text.toLowerCase()
  const hasTeamIntent = TEAM_INTENT_PATTERN.test(normalized)
  if (!hasTeamIntent) return false

  return countTopicSeparators(normalized) >= 2
}

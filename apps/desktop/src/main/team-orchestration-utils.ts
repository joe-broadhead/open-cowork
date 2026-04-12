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

function hasListMarkers(text: string) {
  return /(?:^|\n)\s*(?:[-*]|\d+\.)\s+\S/m.test(text)
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
  if ((requestedAgent || 'assistant') !== 'assistant' && requestedAgent !== 'cowork') return false
  if (attachments && attachments.length > 0) return false

  const normalized = text.toLowerCase()
  const separatorCount = countTopicSeparators(normalized)
  const hasTeamIntent = TEAM_INTENT_PATTERN.test(normalized)
  const hasExplicitParallel = /\bparallel\b/i.test(normalized)
  const hasStructuredTopics = hasListMarkers(text)

  if (hasExplicitParallel || hasStructuredTopics) return true
  if (hasTeamIntent && separatorCount >= 1) return true
  return false
}

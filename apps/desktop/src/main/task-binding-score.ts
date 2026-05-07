import {
  normalizeAgentName,
  normalizeTaskTitle,
} from './task-run-utils.ts'

export type BindingHints = {
  title?: string | null
  agent?: string | null
}

function normalizeBindingHints(hints?: BindingHints | null) {
  return {
    title: normalizeTaskTitle(hints?.title) || null,
    agent: normalizeAgentName(hints?.agent) || null,
  }
}

export function computeBindingScore(
  candidate: { title?: string | null; agent?: string | null },
  hints?: BindingHints | null,
) {
  const normalizedHints = normalizeBindingHints(hints)
  if (!normalizedHints.title && !normalizedHints.agent) return 0

  let score = 0
  const candidateAgent = normalizeAgentName(candidate.agent) || null
  const candidateTitle = normalizeTaskTitle(candidate.title) || null

  if (normalizedHints.agent && candidateAgent && normalizedHints.agent === candidateAgent) {
    score += 4
  }

  if (normalizedHints.title && candidateTitle) {
    if (normalizedHints.title === candidateTitle) {
      score += 3
    }
  }

  return score
}

export function findBestIndexedMatch<T extends { title?: string | null; agent?: string | null }>(
  entries: T[],
  hints?: BindingHints | null,
) {
  if (entries.length <= 1) return entries.length === 1 ? 0 : -1

  let bestIndex = -1
  let bestScore = 0
  let ambiguous = false

  for (const [index, entry] of entries.entries()) {
    const score = computeBindingScore(entry, hints)
    if (score > bestScore) {
      bestScore = score
      bestIndex = index
      ambiguous = false
    } else if (score > 0 && score === bestScore) {
      ambiguous = true
    }
  }

  if (bestIndex >= 0 && !ambiguous) return bestIndex
  return -1
}

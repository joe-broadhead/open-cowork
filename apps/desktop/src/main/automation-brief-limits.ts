import type { ExecutionBrief } from '@open-cowork/shared'

export const AUTOMATION_BRIEF_LIMITS = {
  text: 8 * 1024,
  arrayItems: 32,
  workItems: 128,
  workItemId: 128,
  workItemTitle: 512,
  workItemDescription: 4 * 1024,
  dependsOn: 32,
  agentName: 128,
  heartbeatText: 4 * 1024,
} as const

export function limitTextValue(value: string | null | undefined, maxLength = AUTOMATION_BRIEF_LIMITS.text) {
  return (value || '').slice(0, maxLength)
}

export function limitTextArray(
  values: string[] | null | undefined,
  maxItems = AUTOMATION_BRIEF_LIMITS.arrayItems,
  maxLength = AUTOMATION_BRIEF_LIMITS.text,
) {
  return (Array.isArray(values) ? values : [])
    .filter((entry): entry is string => typeof entry === 'string')
    .slice(0, maxItems)
    .map((entry) => limitTextValue(entry, maxLength))
}

function shortStableHash(value: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36).padStart(7, '0').slice(0, 7)
}

function appendIdSuffix(baseId: string, suffix: string) {
  const maxPrefixLength = Math.max(1, AUTOMATION_BRIEF_LIMITS.workItemId - suffix.length - 1)
  return `${baseId.slice(0, maxPrefixLength)}-${suffix}`
}

function uniqueWorkItemId(rawId: string, fallbackId: string, index: number, usedIds: Set<string>) {
  const sourceId = rawId.trim() || fallbackId
  const cappedId = limitTextValue(sourceId, AUTOMATION_BRIEF_LIMITS.workItemId).trim() || fallbackId
  if (!usedIds.has(cappedId)) {
    usedIds.add(cappedId)
    return cappedId
  }

  const hashedId = appendIdSuffix(cappedId, shortStableHash(`${sourceId}:${index}`))
  if (!usedIds.has(hashedId)) {
    usedIds.add(hashedId)
    return hashedId
  }

  let counter = 2
  while (true) {
    const candidate = appendIdSuffix(cappedId, `${shortStableHash(sourceId)}-${counter}`)
    if (!usedIds.has(candidate)) {
      usedIds.add(candidate)
      return candidate
    }
    counter += 1
  }
}

export function normalizeExecutionBriefForStorage(brief: ExecutionBrief): ExecutionBrief {
  const workItems = Array.isArray(brief.workItems)
    ? brief.workItems.slice(0, AUTOMATION_BRIEF_LIMITS.workItems)
    : []
  const usedWorkItemIds = new Set<string>()
  const normalizedIds = workItems.map((item, index) => uniqueWorkItemId(
    typeof item.id === 'string' ? item.id : '',
    `work-item-${index + 1}`,
    index,
    usedWorkItemIds,
  ))
  const idByOriginal = new Map<string, string>()
  const idByCapped = new Map<string, string>()
  workItems.forEach((item, index) => {
    const rawId = typeof item.id === 'string' ? item.id.trim() : ''
    const cappedId = limitTextValue(rawId, AUTOMATION_BRIEF_LIMITS.workItemId).trim()
    if (rawId && !idByOriginal.has(rawId)) idByOriginal.set(rawId, normalizedIds[index]!)
    if (cappedId && !idByCapped.has(cappedId)) idByCapped.set(cappedId, normalizedIds[index]!)
  })

  return {
    ...brief,
    goal: limitTextValue(brief.goal),
    deliverables: limitTextArray(brief.deliverables),
    assumptions: limitTextArray(brief.assumptions),
    missingContext: limitTextArray(brief.missingContext),
    successCriteria: limitTextArray(brief.successCriteria),
    recommendedAgents: limitTextArray(brief.recommendedAgents, AUTOMATION_BRIEF_LIMITS.arrayItems, AUTOMATION_BRIEF_LIMITS.agentName),
    approvalBoundary: limitTextValue(brief.approvalBoundary),
    workItems: workItems
      .map((item, index) => ({
        id: normalizedIds[index]!,
        title: limitTextValue(item.title, AUTOMATION_BRIEF_LIMITS.workItemTitle).trim() || `Work item ${index + 1}`,
        description: limitTextValue(item.description, AUTOMATION_BRIEF_LIMITS.workItemDescription),
        ownerAgent: item.ownerAgent === null ? null : limitTextValue(item.ownerAgent, AUTOMATION_BRIEF_LIMITS.agentName).trim() || null,
        dependsOn: (Array.isArray(item.dependsOn) ? item.dependsOn : [])
          .filter((entry): entry is string => typeof entry === 'string')
          .slice(0, AUTOMATION_BRIEF_LIMITS.dependsOn)
          .map((entry) => {
            const dependencyId = entry.trim()
            return idByOriginal.get(dependencyId)
              || idByCapped.get(limitTextValue(dependencyId, AUTOMATION_BRIEF_LIMITS.workItemId).trim())
              || limitTextValue(dependencyId, AUTOMATION_BRIEF_LIMITS.workItemId).trim()
          })
          .filter(Boolean),
      })),
  }
}

export function executionBriefApprovalRevision(brief: ExecutionBrief | null | undefined) {
  if (!brief?.approvedAt) return null
  const normalized = normalizeExecutionBriefForStorage(brief)
  const { approvedAt: _approvedAt, ...revision } = normalized
  return JSON.stringify(revision)
}

import type {
  BuiltInAgentDetail,
  CrewApprovalPolicy,
  CrewDefinitionDraft,
  CrewMemberDraft,
  CrewRunDraft,
  CrewRunUrgency,
  CustomAgentSummary,
  RuntimeAgentDescriptor,
  WorkspaceProfile,
} from '@open-cowork/shared'

export const CREW_BUILDER_V2_FEATURE_GATE_KEY = 'open-cowork.feature.crewBuilderV2'

export type CrewAgentOptionSource = 'built-in' | 'custom' | 'runtime'

export type CrewAgentOption = {
  name: string
  label: string
  description: string
  source: CrewAgentOptionSource
  model: string | null
  skills: string[]
  tools: string[]
  disabled: boolean
  writeAccess: boolean
}

export type CrewTemplateId = 'operations' | 'analysis' | 'delivery'

export type CrewTemplate = {
  id: CrewTemplateId
  label: string
  description: string
  draft: Omit<CrewDefinitionDraft, 'members'> & { members: CrewMemberDraft[] }
}

export type CrewRunRequestDraft = {
  title: string
  workItemTitle: string
  objective: string
  expectedDeliverable: string
  constraints: string
  dueAt: string
  urgency: CrewRunUrgency
  budgetCapUsd: string
  approvalRequirements: string
  sourceContext: string
}

const DEFAULT_APPROVAL_POLICY: CrewApprovalPolicy = 'review-before-delivery'

export const CREW_TEMPLATES: CrewTemplate[] = [
  {
    id: 'operations',
    label: 'Operations team',
    description: 'Lead planning, specialist execution, and evaluator review for recurring product work.',
    draft: {
      name: 'Operations Team',
      description: 'Reusable team for scoped planning, specialist execution, and final quality review.',
      workspaceProfileId: null,
      outcomeRubricId: null,
      evalSuiteId: null,
      budgetCapUsd: 4,
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      members: [
        { role: 'lead', agentName: 'plan', displayName: 'Planner', description: 'Scopes the work, assigns branches, and keeps the run on policy.', required: true },
        { role: 'specialist', agentName: 'explore', displayName: 'Explorer', description: 'Maps unknowns, gathers evidence, and reports risks.', required: true },
        { role: 'specialist', agentName: 'build', displayName: 'Builder', description: 'Produces the requested artifact or implementation.', required: true },
        { role: 'evaluator', agentName: 'general', displayName: 'Evaluator', description: 'Checks the result against the crew rubric before delivery.', required: true },
      ],
    },
  },
  {
    id: 'analysis',
    label: 'Analysis team',
    description: 'Evidence gathering, synthesis, and evaluator review for investigation-heavy work.',
    draft: {
      name: 'Analysis Team',
      description: 'Reusable team for evidence-backed analysis, synthesis, and quality review.',
      workspaceProfileId: null,
      outcomeRubricId: null,
      evalSuiteId: null,
      budgetCapUsd: 3,
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      members: [
        { role: 'lead', agentName: 'plan', displayName: 'Lead Analyst', description: 'Frames the question, assigns specialist branches, and manages scope.', required: true },
        { role: 'specialist', agentName: 'explore', displayName: 'Evidence Specialist', description: 'Finds sources, extracts facts, and records confidence.', required: true },
        { role: 'specialist', agentName: 'general', displayName: 'Synthesis Specialist', description: 'Combines findings into a coherent answer.', required: true },
        { role: 'evaluator', agentName: 'build', displayName: 'Quality Reviewer', description: 'Checks completeness, evidence quality, and actionability.', required: true },
      ],
    },
  },
  {
    id: 'delivery',
    label: 'Delivery team',
    description: 'Builder-led artifact creation with review gates before the result is shipped.',
    draft: {
      name: 'Delivery Team',
      description: 'Reusable team for producing, checking, and delivering user-facing work.',
      workspaceProfileId: null,
      outcomeRubricId: null,
      evalSuiteId: null,
      budgetCapUsd: 5,
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      members: [
        { role: 'lead', agentName: 'build', displayName: 'Delivery Lead', description: 'Owns the final artifact and coordinates supporting branches.', required: true },
        { role: 'specialist', agentName: 'plan', displayName: 'Scope Reviewer', description: 'Checks constraints, acceptance criteria, and sequencing.', required: true },
        { role: 'specialist', agentName: 'explore', displayName: 'Evidence Specialist', description: 'Verifies assumptions and external context.', required: true },
        { role: 'evaluator', agentName: 'general', displayName: 'Release Reviewer', description: 'Grades the output and calls out remaining risks.', required: true },
      ],
    },
  },
]

export function isCrewBuilderV2Enabled(storage?: Storage | null) {
  try {
    const target = storage || (typeof window !== 'undefined' ? window.localStorage : null)
    return target?.getItem(CREW_BUILDER_V2_FEATURE_GATE_KEY) === 'true'
  } catch {
    return false
  }
}

function cloneDraft(draft: CrewDefinitionDraft): CrewDefinitionDraft {
  return {
    ...draft,
    members: draft.members.map((member) => ({ ...member })),
  }
}

function agentByName(options: readonly CrewAgentOption[]) {
  return new Map(options.map((option) => [option.name, option]))
}

function pickAgentName(preferred: string, fallback: string, options: readonly CrewAgentOption[]) {
  if (options.length === 0) return preferred
  const byName = agentByName(options)
  if (byName.has(preferred)) return preferred
  if (byName.has(fallback)) return fallback
  return options.find((option) => !option.disabled)?.name || preferred
}

export function draftFromCrewTemplate(templateId: CrewTemplateId, options: readonly CrewAgentOption[] = []) {
  const template = CREW_TEMPLATES.find((entry) => entry.id === templateId) || CREW_TEMPLATES[0]!
  const draft = cloneDraft(template.draft)
  const fallbackByRole: Record<CrewMemberDraft['role'], string> = {
    lead: 'plan',
    specialist: 'general',
    evaluator: 'general',
  }
  return {
    ...draft,
    members: draft.members.map((member) => ({
      ...member,
      agentName: pickAgentName(member.agentName, fallbackByRole[member.role], options),
    })),
  }
}

export function emptyRunRequest(crewName = 'Crew'): CrewRunRequestDraft {
  return {
    title: `${crewName} run`,
    workItemTitle: '',
    objective: '',
    expectedDeliverable: '',
    constraints: '',
    dueAt: '',
    urgency: 'normal',
    budgetCapUsd: '',
    approvalRequirements: 'Review evaluator verdict before delivery.',
    sourceContext: '',
  }
}

function uniquePush(map: Map<string, CrewAgentOption>, option: CrewAgentOption) {
  const key = option.name.trim()
  if (!key || map.has(key)) return
  map.set(key, { ...option, name: key })
}

export function buildCrewAgentOptions(input: {
  builtInAgents?: readonly BuiltInAgentDetail[]
  customAgents?: readonly CustomAgentSummary[]
  runtimeAgents?: readonly RuntimeAgentDescriptor[]
}): CrewAgentOption[] {
  const map = new Map<string, CrewAgentOption>()
  for (const agent of input.builtInAgents || []) {
    if (agent.hidden) continue
    uniquePush(map, {
      name: agent.name,
      label: agent.label || agent.name,
      description: agent.description || 'Built-in agent',
      source: 'built-in',
      model: agent.model || null,
      skills: agent.skills || [],
      tools: [...(agent.nativeToolIds || []), ...(agent.configuredToolIds || [])],
      disabled: agent.disabled,
      writeAccess: (agent.configuredToolIds || []).length > 0 || (agent.nativeToolIds || []).some((tool) => ['edit', 'write', 'apply_patch', 'bash'].includes(tool)),
    })
  }
  for (const agent of input.customAgents || []) {
    uniquePush(map, {
      name: agent.name,
      label: agent.name,
      description: agent.description || 'Custom agent',
      source: 'custom',
      model: agent.model || null,
      skills: agent.skillNames || [],
      tools: agent.toolIds || [],
      disabled: !agent.enabled || !agent.valid,
      writeAccess: agent.writeAccess,
    })
  }
  for (const agent of input.runtimeAgents || []) {
    uniquePush(map, {
      name: agent.name,
      label: agent.name,
      description: agent.description || 'Runtime agent',
      source: 'runtime',
      model: agent.model || null,
      skills: [],
      tools: agent.toolIds || [],
      disabled: Boolean(agent.disabled),
      writeAccess: Boolean(agent.writeAccess),
    })
  }
  return Array.from(map.values()).sort((left, right) => left.label.localeCompare(right.label) || left.name.localeCompare(right.name))
}

export function summarizeAgentOption(option: CrewAgentOption | undefined) {
  if (!option) return 'No matching agent metadata loaded.'
  const parts = [
    option.source,
    option.model ? `model ${option.model}` : null,
    option.skills.length ? `${option.skills.length} skills` : null,
    option.tools.length ? `${option.tools.length} tools` : null,
    option.writeAccess ? 'write-capable' : 'read-oriented',
  ].filter(Boolean)
  return parts.join(' | ')
}

export function validateCrewDraftForBuilder(draft: CrewDefinitionDraft, options: readonly CrewAgentOption[] = []) {
  const issues: string[] = []
  if (!draft.name.trim()) issues.push('Crew name is required.')
  if (!draft.description.trim()) issues.push('Crew purpose is required.')
  const knownAgents = new Set(options.map((option) => option.name))
  const duplicateAgents = new Set<string>()
  const seenAgents = new Set<string>()
  for (const member of draft.members) {
    const agentName = member.agentName.trim()
    if (!agentName) issues.push('Every crew member needs an assigned agent.')
    if (options.length > 0 && agentName && !knownAgents.has(agentName)) issues.push(`${agentName} is not in the loaded agent catalog.`)
    if (agentName) {
      if (seenAgents.has(agentName)) duplicateAgents.add(agentName)
      seenAgents.add(agentName)
    }
  }
  for (const agentName of duplicateAgents) issues.push(`${agentName} is assigned to more than one member.`)
  if (draft.members.filter((member) => member.role === 'lead').length < 1) issues.push('At least one lead is required.')
  if (draft.members.filter((member) => member.role === 'specialist').length < 2) issues.push('At least two specialists are required.')
  if (draft.members.filter((member) => member.role === 'evaluator').length < 1) issues.push('At least one evaluator is required.')
  if (draft.budgetCapUsd !== null && draft.budgetCapUsd !== undefined && (!Number.isFinite(draft.budgetCapUsd) || draft.budgetCapUsd <= 0)) {
    issues.push('Budget cap must be a positive number.')
  }
  if (draft.approvalPolicy && draft.approvalPolicy !== 'review-before-delivery' && draft.approvalPolicy !== 'auto-deliver-after-evaluation') {
    issues.push('Approval policy is invalid.')
  }
  return issues
}

export function normalizeWorkspaceProfileId(value: string, profiles: readonly WorkspaceProfile[]) {
  if (!value || value === 'default') return null
  return profiles.some((profile) => profile.id === value) ? value : null
}

export function runDraftFromRequest(crewId: string, request: CrewRunRequestDraft): CrewRunDraft {
  return {
    crewId,
    title: request.title.trim(),
    workItemTitle: request.workItemTitle.trim() || request.title.trim(),
    workItemDescription: request.objective.trim(),
    expectedDeliverable: request.expectedDeliverable.trim() || null,
    constraints: request.constraints.trim() || null,
    dueAt: request.dueAt.trim() || null,
    urgency: request.urgency,
    budgetCapUsd: request.budgetCapUsd.trim() ? Number(request.budgetCapUsd) : null,
    approvalRequirements: request.approvalRequirements.trim() || null,
    sourceContext: request.sourceContext.trim() || null,
    workItemSource: 'manual',
  }
}

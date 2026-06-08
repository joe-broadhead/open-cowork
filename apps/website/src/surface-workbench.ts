type CapabilityWithAgents = {
  id?: string
  name?: string
  label?: string
  source?: string
  origin?: string | null
  scope?: string | null
  kind?: string
  namespace?: string | null
  agentNames?: string[]
  toolIds?: string[]
}

export type CloudWebWorkbenchAgent = {
  name: string
  toolCount: number
  skillCount: number
  custom: boolean
}

export type CloudWebCoworkerOption = {
  name: string
  displayName: string
  role: string
  availability: string
  capabilityHint: string
  custom: boolean
}

const COWORKER_TONES = [
  'var(--color-accent)',
  'var(--color-green)',
  'var(--color-amber)',
  'var(--color-red)',
] as const
const LEADING_COWORKER_MENTION_PATTERN = /^(\s*)@([a-zA-Z0-9._/-]+)(?:[\s,;:!?]+|$)/
const COWORKER_MENTION_SEPARATOR_PATTERN = /^(?:[\s,;:!?)\]}]+|\.(?:\s+|$)|$)/

function asList<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

function hashText(value: string) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }
  return hash
}

function knownCoworkerMentionAt(input: string, atIndex: number, normalizedAgents: Map<string, string>) {
  if (input[atIndex] !== '@' || normalizedAgents.size === 0) return null
  const mentionBody = input.slice(atIndex + 1)
  const lowerBody = mentionBody.toLowerCase()
  const agentEntries = [...normalizedAgents.entries()].sort((a, b) => b[0].length - a[0].length)
  for (const [normalizedName, agent] of agentEntries) {
    if (!lowerBody.startsWith(normalizedName)) continue
    const remainder = mentionBody.slice(normalizedName.length)
    const separator = remainder.match(COWORKER_MENTION_SEPARATOR_PATTERN)
    if (!separator) continue
    return {
      agent,
      length: 1 + normalizedName.length + separator[0].length,
    }
  }
  return null
}

function leadingKnownCoworkerMention(input: string, normalizedAgents: Map<string, string>) {
  return knownCoworkerMentionAt(input, 0, normalizedAgents)
}

export function cloudWebCoworkerInitials(name: string) {
  const parts = name.trim().split(/[\s._/-]+/).filter(Boolean)
  if (!parts.length) return 'OC'
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase() || '').join('') || 'OC'
}

export function cloudWebCoworkerTone(name: string) {
  const cleaned = name.trim()
  return COWORKER_TONES[hashText(cleaned || 'default') % COWORKER_TONES.length]
}

function agentOptionRecord(agent: unknown): Record<string, unknown> {
  return agent && typeof agent === 'object' && !Array.isArray(agent) ? agent as Record<string, unknown> : {}
}

function coworkerRoleFromName(name: string) {
  const cleaned = name.replace(/[-_.]+/g, ' ').trim()
  if (!cleaned) return 'Studio coworker'
  return `${cleaned[0]?.toUpperCase() || ''}${cleaned.slice(1)} coworker`
}

export function cloudWebCoworkerOptionsFromWorkspace(workspace: unknown, profileName = 'default'): CloudWebCoworkerOption[] {
  const workspaceRecord = agentOptionRecord(workspace)
  const policy = agentOptionRecord(workspaceRecord.policy)
  const allowedAgents = asList<unknown>(policy.allowedAgents)
  return allowedAgents.map((agent) => {
    const record = agentOptionRecord(agent)
    const name = String(typeof agent === 'string' ? agent : record.name || '').trim()
    if (!name) return null
    const role = String(record.role || record.title || record.description || coworkerRoleFromName(name))
    const status = String(record.status || record.availability || (record.disabled ? 'unavailable' : 'available'))
    const tools = asList(record.toolIds)
    const skills = asList(record.skillNames || record.skills)
    const capabilityHint = String(record.capabilityHint || record.summary || [
      tools.length ? `${tools.length} tool${tools.length === 1 ? '' : 's'}` : null,
      skills.length ? `${skills.length} skill${skills.length === 1 ? '' : 's'}` : null,
      `profile ${profileName}`,
    ].filter(Boolean).join(' - '))
    return {
      name,
      displayName: String(record.label || record.displayName || name),
      role,
      availability: status,
      capabilityHint,
      custom: record.source === 'custom' || record.origin === 'custom' || record.custom === true,
    }
  }).filter((agent): agent is CloudWebCoworkerOption => Boolean(agent))
}

export function firstCloudWebMentionedCoworker(input: string, allowedAgents: string[]) {
  if (!input.trim() || !allowedAgents.length) return ''
  const normalized = new Map(allowedAgents.map((agent) => [agent.toLowerCase(), agent]))
  const mentionPattern = /(^|[\s([{])@/g
  let match: RegExpExecArray | null
  while ((match = mentionPattern.exec(input)) !== null) {
    const atIndex = match.index + (match[1] || '').length
    const mention = knownCoworkerMentionAt(input, atIndex, normalized)
    if (mention) return mention.agent
  }
  return ''
}

export function ensureCloudWebCoworkerMention(input: string, agentName: string) {
  const agent = agentName.trim()
  if (!agent) return input
  const mention = `@${agent}`
  const leadingMention = input.match(LEADING_COWORKER_MENTION_PATTERN)
  if (leadingMention) {
    return leadingMention[2]?.toLowerCase() === agent.toLowerCase()
      ? input
      : input.replace(LEADING_COWORKER_MENTION_PATTERN, (match, leading: string, _current: string, offset: number) => {
        const hasRemainder = input.slice(offset + match.length).length > 0
        return hasRemainder ? `${leading}${mention} ` : `${leading}${mention}`
      })
  }
  const tokens = input.split(/\s+/).map((token) => token.replace(/^[([{]+|[)\]},.!?;:]+$/g, '').toLowerCase())
  if (tokens.includes(mention.toLowerCase())) return input
  return input.trim() ? `${mention} ${input}` : `${mention} `
}

export function cloudWebPromptAssignment(input: string, allowedAgents: string[], selectedAgent = '') {
  const text = input.trim()
  const selected = selectedAgent.trim()
  const normalized = new Map(allowedAgents.map((agent) => [agent.toLowerCase(), agent]))
  if (selected) normalized.set(selected.toLowerCase(), selected)
  const directMention = leadingKnownCoworkerMention(text, normalized)
  if (directMention) {
    return {
      agent: directMention.agent,
      text: text.slice(directMention.length).trimStart(),
      source: 'mention' as const,
    }
  }
  const mentioned = firstCloudWebMentionedCoworker(text, allowedAgents)
  return {
    agent: selected || mentioned || '',
    text,
    source: selected ? 'selected' as const : mentioned ? 'mention' as const : 'default' as const,
  }
}

export function deriveCloudWebWorkbenchAgents(input: {
  policyAllowedAgents?: string[] | null
  tools?: CapabilityWithAgents[]
  skills?: CapabilityWithAgents[]
}): CloudWebWorkbenchAgent[] {
  const agents = new Map<string, CloudWebWorkbenchAgent>()
  const ensure = (name: string) => {
    const cleaned = name.trim()
    if (!cleaned) return null
    const current = agents.get(cleaned) || {
      name: cleaned,
      toolCount: 0,
      skillCount: 0,
      custom: false,
    }
    agents.set(cleaned, current)
    return current
  }

  for (const name of asList<string>(input.policyAllowedAgents)) ensure(name)
  for (const tool of asList<CapabilityWithAgents>(input.tools)) {
    for (const name of asList<string>(tool.agentNames)) {
      const agent = ensure(name)
      if (!agent) continue
      agent.toolCount += 1
      agent.custom = agent.custom || tool.source === 'custom' || tool.origin === 'custom'
    }
  }
  for (const skill of asList<CapabilityWithAgents>(input.skills)) {
    for (const name of asList<string>(skill.agentNames)) {
      const agent = ensure(name)
      if (!agent) continue
      agent.skillCount += 1
      agent.custom = agent.custom || skill.source === 'custom' || skill.origin === 'custom'
    }
  }

  return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function cloudWebCapabilityLabel(capability: CapabilityWithAgents) {
  return capability.label || capability.name || capability.id || 'Capability'
}

export function cloudWebCapabilityPolicyNote(capability: CapabilityWithAgents) {
  if (capability.kind === 'mcp' && capability.scope === 'machine') {
    return 'Machine-scoped MCP metadata is visible only when converted to a cloud-safe profile capability.'
  }
  if (capability.source === 'custom') {
    return 'Custom content is synced as metadata and executable only when this org profile allows it.'
  }
  return 'Allowed by current cloud profile.'
}

export function filterCloudWebCapabilities<T extends CapabilityWithAgents>(items: T[], query = ''): T[] {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return items
  return items.filter((item) => {
    const haystack = [
      item.id,
      item.name,
      item.label,
      item.source,
      item.origin,
      item.scope,
      item.kind,
      item.namespace,
      ...asList<string>(item.agentNames),
      ...asList<string>(item.toolIds),
    ].filter(Boolean).join(' ').toLowerCase()
    return tokens.every((token) => haystack.includes(token))
  })
}

export function cloudWebWorkflowTriggerSummary(workflow: { triggers?: Array<{ type?: string, enabled?: boolean }> }) {
  const triggers = asList<{ type?: string, enabled?: boolean }>(workflow.triggers)
    .filter((trigger) => trigger.enabled !== false)
    .map((trigger) => trigger.type || 'trigger')
  return triggers.length ? triggers.join(', ') : 'manual'
}

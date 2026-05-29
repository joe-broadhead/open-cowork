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

function asList<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
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

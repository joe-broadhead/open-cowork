export type AgentColor = 'primary' | 'warning' | 'accent' | 'success' | 'info' | 'secondary'

export type CustomSkillLike = {
  name: string
  content: string
}

export type CustomAgentLike = {
  name: string
  description: string
  instructions: string
  skillNames: string[]
  integrationIds: string[]
  enabled: boolean
  color: AgentColor
}

export type IntegrationBundleLike = {
  id: string
  name: string
  icon: string
  description: string
  allowedTools?: string[]
  skills: Array<{ name: string; description: string; sourceName: string }>
  credentials?: Array<{ key: string }>
  mcps: Array<{ headerSettings?: Array<{ key: string }>; envSettings?: Array<{ key: string }> }>
  agentAccess?: {
    readToolPatterns: string[]
    writeToolPatterns?: string[]
  }
}

export type SettingsLike = {
  customSkills: CustomSkillLike[]
  customAgents: CustomAgentLike[]
  integrationCredentials?: Record<string, Record<string, string>>
  [key: string]: unknown
}

export type CustomAgentIssue = {
  code: string
  message: string
}

export type CustomAgentCatalogIntegration = {
  id: string
  name: string
  icon: string
  description: string
  supportsWrite: boolean
}

export type CustomAgentCatalogSkill = {
  name: string
  label: string
  description: string
  source: 'bundle' | 'custom'
  integrationId?: string | null
}

export type CustomAgentCatalog = {
  integrations: CustomAgentCatalogIntegration[]
  skills: CustomAgentCatalogSkill[]
  reservedNames: string[]
  colors: AgentColor[]
}

export type CustomAgentSummary = CustomAgentLike & {
  writeAccess: boolean
  valid: boolean
  issues: CustomAgentIssue[]
}

export type RuntimeCustomAgent = {
  name: string
  description: string
  instructions: string
  skillNames: string[]
  integrationNames: string[]
  writeAccess: boolean
  color: AgentColor
  allowPatterns: string[]
  askPatterns: string[]
}

export const CUSTOM_AGENT_COLORS: AgentColor[] = [
  'accent',
  'primary',
  'success',
  'info',
  'warning',
  'secondary',
]

export const RESERVED_AGENT_NAMES = [
  'assistant',
  'plan',
  'research',
  'explore',
  'build',
  'general',
  'title',
  'summary',
  'compaction',
]

const VALID_AGENT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function unique(values: string[]) {
  return Array.from(new Set(values))
}

function humanize(value: string) {
  return value
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function extractFrontmatterDescription(content: string) {
  const match = content.match(/^---\n[\s\S]*?\ndescription:\s*["']?(.+?)["']?\s*(?:\n|$)/m)
  if (!match?.[1]) return null
  return match[1].trim()
}

function hasConfiguredCredentials(bundle: IntegrationBundleLike, settings: SettingsLike) {
  const integrationCredentials = settings.integrationCredentials || {}
  const values = integrationCredentials[bundle.id] || {}

  for (const credential of bundle.credentials || []) {
    if ((credential as any).required === false) continue
    if (typeof values[credential.key] !== 'string' || !values[credential.key].trim()) {
      return false
    }
  }

  const requiredKeys = new Set<string>()
  for (const mcp of bundle.mcps) {
    for (const header of mcp.headerSettings || []) requiredKeys.add(header.key)
    for (const envSetting of mcp.envSettings || []) requiredKeys.add(envSetting.key)
  }

  for (const key of requiredKeys) {
    if (typeof values[key] !== 'string' || !values[key].trim()) {
      return false
    }
  }

  return true
}

export function normalizeCustomAgent(input: CustomAgentLike): CustomAgentLike {
  return {
    name: (input.name || '').trim().toLowerCase(),
    description: (input.description || '').trim(),
    instructions: (input.instructions || '').trim(),
    skillNames: unique((input.skillNames || []).map((value) => value.trim()).filter(Boolean)),
    integrationIds: unique((input.integrationIds || []).map((value) => value.trim()).filter(Boolean)),
    enabled: input.enabled !== false,
    color: CUSTOM_AGENT_COLORS.includes(input.color) ? input.color : 'accent',
  }
}

export function buildCustomAgentCatalog(input: {
  enabledBundles: IntegrationBundleLike[]
  customSkills: CustomSkillLike[]
  settings: SettingsLike
}): CustomAgentCatalog {
  const integrations = input.enabledBundles
    .filter((bundle) => bundle.agentAccess?.readToolPatterns?.length)
    .filter((bundle) => hasConfiguredCredentials(bundle, input.settings))
    .map((bundle) => ({
      id: bundle.id,
      name: bundle.name,
      icon: bundle.icon,
      description: bundle.description,
      supportsWrite: Boolean(bundle.agentAccess?.writeToolPatterns?.length),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const skills = new Map<string, CustomAgentCatalogSkill>()
  for (const bundle of input.enabledBundles) {
    if (!hasConfiguredCredentials(bundle, input.settings)) continue
    for (const skill of bundle.skills) {
      skills.set(skill.sourceName, {
        name: skill.sourceName,
        label: skill.name,
        description: skill.description,
        source: 'bundle',
        integrationId: bundle.id,
      })
    }
  }

  for (const skill of input.customSkills) {
    skills.set(skill.name, {
      name: skill.name,
      label: humanize(skill.name),
      description: extractFrontmatterDescription(skill.content) || 'Custom skill',
      source: 'custom',
      integrationId: null,
    })
  }

  return {
    integrations,
    skills: Array.from(skills.values()).sort((a, b) => a.label.localeCompare(b.label)),
    reservedNames: [...RESERVED_AGENT_NAMES],
    colors: [...CUSTOM_AGENT_COLORS],
  }
}

export function validateCustomAgent(agent: CustomAgentLike, catalog: CustomAgentCatalog, siblingNames: string[] = []): CustomAgentIssue[] {
  const normalized = normalizeCustomAgent(agent)
  const issues: CustomAgentIssue[] = []

  if (!normalized.name || !VALID_AGENT_NAME.test(normalized.name)) {
    issues.push({
      code: 'invalid_name',
      message: 'Use lowercase letters, numbers, and hyphens only for the sub-agent name.',
    })
  }

  if (catalog.reservedNames.includes(normalized.name)) {
    issues.push({
      code: 'reserved_name',
      message: `"${normalized.name}" is reserved by Open Cowork or OpenCode.`,
    })
  }

  if (siblingNames.includes(normalized.name)) {
    issues.push({
      code: 'duplicate_name',
      message: `A custom sub-agent named "${normalized.name}" already exists.`,
    })
  }

  if (!normalized.description) {
    issues.push({
      code: 'missing_description',
      message: 'Add a short description so Open Cowork knows when to delegate to this sub-agent.',
    })
  }

  const integrationMap = new Map(catalog.integrations.map((integration) => [integration.id, integration]))
  const skillMap = new Map(catalog.skills.map((skill) => [skill.name, skill]))

  for (const integrationId of normalized.integrationIds) {
    if (!integrationMap.has(integrationId)) {
      issues.push({
        code: 'missing_integration',
        message: `The integration "${integrationId}" is no longer enabled or configured.`,
      })
    }
  }

  for (const skillName of normalized.skillNames) {
    if (!skillMap.has(skillName)) {
      issues.push({
        code: 'missing_skill',
        message: `The skill "${skillName}" is not currently available.`,
      })
    }
  }

  return issues
}

function runtimeAgentAccessPatterns(agent: CustomAgentLike, bundles: IntegrationBundleLike[]) {
  const selectedBundles = bundles.filter((bundle) => agent.integrationIds.includes(bundle.id))
  const allowPatterns = new Set<string>()
  const askPatterns = new Set<string>()

  for (const bundle of selectedBundles) {
    for (const pattern of bundle.agentAccess?.readToolPatterns || []) {
      allowPatterns.add(pattern)
    }

    for (const pattern of bundle.agentAccess?.writeToolPatterns || []) {
      askPatterns.add(pattern)
    }
  }

  return {
    allowPatterns: Array.from(allowPatterns),
    askPatterns: Array.from(askPatterns),
  }
}

function deriveWriteCapability(agent: CustomAgentLike, catalog: CustomAgentCatalog) {
  const integrationMap = new Map(catalog.integrations.map((integration) => [integration.id, integration]))
  return agent.integrationIds.some((integrationId) => Boolean(integrationMap.get(integrationId)?.supportsWrite))
}

export function summarizeCustomAgents(input: {
  settings: SettingsLike
  enabledBundles: IntegrationBundleLike[]
}): CustomAgentSummary[] {
  const catalog = buildCustomAgentCatalog({
    enabledBundles: input.enabledBundles,
    customSkills: input.settings.customSkills || [],
    settings: input.settings,
  })
  const agents = input.settings.customAgents || []

  return agents.map((agent, index) => {
    const normalized = normalizeCustomAgent(agent)
    const siblingNames = agents
      .filter((_, siblingIndex) => siblingIndex !== index)
      .map((entry) => normalizeCustomAgent(entry).name)
    const issues = validateCustomAgent(normalized, catalog, siblingNames)
    const writeAccess = deriveWriteCapability(normalized, catalog)
    return {
      ...normalized,
      writeAccess,
      valid: issues.length === 0,
      issues,
    }
  })
}

export function buildRuntimeCustomAgents(input: {
  settings: SettingsLike
  enabledBundles: IntegrationBundleLike[]
}): RuntimeCustomAgent[] {
  const summaries = summarizeCustomAgents(input)
  const integrationNames = new Map(input.enabledBundles.map((bundle) => [bundle.id, bundle.name]))

  return summaries
    .filter((agent) => agent.enabled && agent.valid)
    .map((agent) => {
      const access = runtimeAgentAccessPatterns(agent, input.enabledBundles)
      return {
        name: agent.name,
        description: agent.description,
        instructions: agent.instructions,
        skillNames: [...agent.skillNames],
        integrationNames: agent.integrationIds.map((integrationId) => integrationNames.get(integrationId) || integrationId),
        writeAccess: agent.writeAccess,
        color: agent.color,
        allowPatterns: access.allowPatterns,
        askPatterns: access.askPatterns,
      }
    })
}

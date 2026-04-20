import {
  getConfiguredAgentsFromConfig,
  getConfiguredSkillsFromConfig,
  getConfiguredToolAllowPatterns,
  getConfiguredToolAskPatterns,
  getConfiguredToolById,
  getConfiguredToolPatterns,
  getConfiguredToolsFromConfig,
  type ConfiguredAgent,
} from './config-loader.ts'
import { configuredToolLabels } from './capability-catalog.ts'
import type { AgentConfig } from '@opencode-ai/sdk/v2'
import { buildPermissionConfig } from './permission-config.ts'
import { getEffectiveSettings } from './settings.ts'
import { getAppConfig, getBrandName, type BuiltInAgentOverrideConfig } from './config-loader.ts'

// Fields a caller (built-in template, configured agent, or custom agent) can
// forward to the SDK AgentConfig beyond prompt/permission/mode/color. All
// optional; unset fields fall back to session defaults.
type InferenceOverrides = {
  model?: string | null
  variant?: string | null
  temperature?: number | null
  top_p?: number | null
  steps?: number | null
  options?: Record<string, unknown> | null
}

function applyInferenceOverrides<T extends AgentConfig>(agent: T, overrides: InferenceOverrides | null | undefined): T {
  if (!overrides) return agent
  const next: AgentConfig = { ...agent }
  if (overrides.model) next.model = overrides.model
  if (overrides.variant) next.variant = overrides.variant
  if (typeof overrides.temperature === 'number') next.temperature = overrides.temperature
  if (typeof overrides.top_p === 'number') next.top_p = overrides.top_p
  if (typeof overrides.steps === 'number') next.steps = overrides.steps
  if (overrides.options && typeof overrides.options === 'object') {
    next.options = {
      ...(typeof next.options === 'object' && next.options ? next.options : {}),
      ...overrides.options,
    }
  }
  return next as T
}

function builtInOverride(name: 'build' | 'plan' | 'general' | 'explore'): BuiltInAgentOverrideConfig | null {
  const overrides = getAppConfig().builtInAgents
  if (!overrides || typeof overrides !== 'object') return null
  const entry = overrides[name]
  return entry && typeof entry === 'object' ? entry : null
}


type AgentPermissionOptions = {
  allToolPatterns: string[]
  allowPatterns?: string[]
  askPatterns?: string[]
  deniedPatterns?: string[]
  skillRules?: Record<string, 'allow' | 'ask' | 'deny'>
  allowBash?: boolean
  askBash?: boolean
  allowEdits?: boolean
  allowWeb?: boolean
  allowQuestion?: boolean
  allowTodoWrite?: boolean
  taskRules?: Record<string, 'allow' | 'ask' | 'deny'>
}

type RuntimeCustomAgent = {
  name: string
  description: string
  instructions: string
  skillNames: string[]
  toolNames: string[]
  writeAccess: boolean
  color: string
  allowPatterns: string[]
  askPatterns: string[]
  deniedPatterns?: string[]
  // Optional inference overrides, forwarded to the SDK AgentConfig verbatim.
  model?: string | null
  variant?: string | null
  temperature?: number | null
  top_p?: number | null
  steps?: number | null
  options?: Record<string, unknown> | null
}

export type BuiltInAgentDetail = {
  name: string
  label: string
  source: 'open-cowork' | 'opencode'
  mode: 'primary' | 'subagent'
  hidden: boolean
  disabled: boolean
  color: string
  description: string
  instructions: string
  skills: string[]
  toolAccess: string[]
  nativeToolIds: string[]
  configuredToolIds: string[]
  // Effective inference overrides from the downstream config, surfaced so
  // the UI can display the model/temperature a user will actually get.
  model?: string | null
  variant?: string | null
  temperature?: number | null
  top_p?: number | null
  steps?: number | null
}

function createPermissionConfig(options: AgentPermissionOptions) {
  return buildPermissionConfig({
    allowAllSkills: !options.skillRules,
    skillRules: options.skillRules,
    toolPatternsToDeny: options.allToolPatterns,
    allowPatterns: options.allowPatterns,
    askPatterns: options.askPatterns,
    deniedPatterns: options.deniedPatterns,
    question: options.allowQuestion ? 'allow' : 'deny',
    task: options.taskRules || 'deny',
    todoWrite: options.allowTodoWrite ? 'allow' : 'deny',
    web: options.allowWeb ? 'allow' : 'deny',
    bash: options.allowBash ? 'allow' : options.askBash ? 'ask' : 'deny',
    edit: options.allowEdits ? 'allow' : 'deny',
  })
}

function configuredToolAccess(agent: ConfiguredAgent) {
  const nativeToolIds = configuredAgentNativeToolIds(agent)
  const configuredToolIds = configuredAgentConfiguredToolIds(agent)
  const labels = [
    ...nativeToolLabels(nativeToolIds),
    ...configuredToolLabels(configuredToolIds),
  ]

  return labels.length > 0 ? unique(labels) : ['No dedicated tools']
}

function configuredAgentAllowPatterns(agent: ConfiguredAgent) {
  const configured = (agent.toolIds || [])
    .flatMap((toolId) => {
      const tool = getConfiguredToolById(toolId)
      return tool ? getConfiguredToolAllowPatterns(tool) : []
    })
  return Array.from(new Set([...(agent.allowTools || []), ...configured]))
}

function configuredAgentAskPatterns(agent: ConfiguredAgent) {
  const configured = (agent.toolIds || [])
    .flatMap((toolId) => {
      const tool = getConfiguredToolById(toolId)
      return tool ? getConfiguredToolAskPatterns(tool) : []
    })
  return Array.from(new Set([...(agent.askTools || []), ...configured]))
}

const NATIVE_TOOL_IDS = new Set([
  'read',
  'grep',
  'glob',
  'list',
  'websearch',
  'webfetch',
  'bash',
  'edit',
  'write',
  'apply_patch',
  'question',
  'todowrite',
  'codesearch',
])

function configuredAgentNativeToolIds(agent: ConfiguredAgent) {
  return unique(
    [...(agent.allowTools || []), ...(agent.askTools || [])]
      .filter((toolId) => NATIVE_TOOL_IDS.has(toolId)),
  )
}

function configuredAgentConfiguredToolIds(agent: ConfiguredAgent) {
  const explicit = agent.toolIds || []
  const byPattern = getConfiguredToolsFromConfig()
    .filter((tool) => {
      const agentPatterns = new Set([
        ...(agent.allowTools || []),
        ...(agent.askTools || []),
      ])
      return getConfiguredToolPatterns(tool).some((pattern) => agentPatterns.has(pattern))
    })
    .map((tool) => tool.id)

  return unique([...explicit, ...byPattern])
}

function getGlobalToolAccess() {
  const tools = getConfiguredToolsFromConfig()
  const allow = Array.from(new Set(tools.flatMap((tool) => getConfiguredToolAllowPatterns(tool))))
  const ask = Array.from(new Set(tools.flatMap((tool) => getConfiguredToolAskPatterns(tool))))
  const all = Array.from(new Set(tools.flatMap((tool) => getConfiguredToolPatterns(tool))))
  return { allow, ask, all }
}

function unique(values: string[]) {
  return Array.from(new Set(values))
}

function createAttachedSkillDirective(skillNames: string[]) {
  if (skillNames.length === 0) {
    return 'No predefined skills are attached to this agent.'
  }
  return [
    `Available skills: ${skillNames.join(', ')}`,
    `Before substantive work, load and follow these attached skills via the skill tool: ${skillNames.join(', ')}.`,
  ].join('\n')
}

function nativeToolLabels(ids: string[]) {
  return ids.map((id) => {
    switch (id) {
      case 'websearch':
        return 'Web Search'
      case 'webfetch':
        return 'Web Fetch'
      case 'todowrite':
        return 'Todo Write'
      case 'apply_patch':
        return 'Apply Patch'
      default:
        return id
          .split(/[_-]/g)
          .filter(Boolean)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(' ')
    }
  })
}

function getNativeToolIdsForBuiltInAgent(name: 'build' | 'plan' | 'general' | 'explore') {
  const settings = getEffectiveSettings()
  const canUseBash = settings.enableBash
  const canWriteFiles = settings.enableFileWrite
  const readOnlyCore = ['read', 'grep', 'glob', 'list']
  const webTools = ['websearch', 'webfetch']
  const writeTools = canWriteFiles ? ['edit', 'write', 'apply_patch'] : []
  const bashTools = canUseBash ? ['bash'] : []

  if (name === 'build') {
    return unique([
      ...readOnlyCore,
      ...webTools,
      ...bashTools,
      ...writeTools,
      'todowrite',
      'question',
    ])
  }

  if (name === 'plan') {
    return unique([
      ...readOnlyCore,
      ...webTools,
      'bash',
    ])
  }

  if (name === 'general') {
    return unique([
      ...readOnlyCore,
      ...webTools,
      ...bashTools,
      ...writeTools,
      'question',
    ])
  }

  return readOnlyCore
}

function createCustomAgentPrompt(agent: RuntimeCustomAgent) {
  const skillLine = agent.skillNames.length > 0
    ? createAttachedSkillDirective(agent.skillNames)
    : 'No predefined skills are available. Work from your instructions and allowed tools only.'
  const toolLine = agent.toolNames.length > 0
    ? `Allowed tools: ${agent.toolNames.join(', ')}`
    : 'No specific tools are attached to this agent.'

  return [
    `You are ${agent.description}.`,
    `You are a user-defined ${getBrandName()} agent running inside the OpenCode agent system.`,
    skillLine,
    toolLine,
    agent.writeAccess
      ? 'Some selected tools can create or update external resources. Those write actions require explicit user approval when invoked.'
      : 'Your selected tools are read-only. Do not attempt writes or side effects.',
    'Do not create nested subtasks.',
    'Return concise structured outputs that the parent agent can merge into the main thread.',
    '',
    'Custom instructions:',
    agent.instructions || 'Follow the mission and selected skills faithfully.',
  ].join('\n')
}

function createConfiguredAgentPrompt(agent: ConfiguredAgent) {
  const skillLine = agent.skillNames?.length
    ? createAttachedSkillDirective(agent.skillNames)
    : 'No predefined skills are attached to this agent.'
  const toolLine = configuredToolAccess(agent).length > 0
    ? `Attached tools: ${configuredToolAccess(agent).join(', ')}`
    : 'No dedicated tools are attached to this agent.'

  return [
    `You are ${agent.label || agent.name}.`,
    agent.description,
    toolLine,
    skillLine,
    `You are a built-in ${getBrandName()} agent running inside the OpenCode agent system.`,
    'Do not create nested subtasks unless the parent explicitly delegates work to you.',
    'Return concise structured outputs that the parent agent can merge into the main thread.',
    '',
    'Instructions:',
    agent.instructions || 'Follow the mission and selected skills faithfully.',
  ].join('\n')
}

function getConfiguredBuiltInAgentDetails(): BuiltInAgentDetail[] {
  return getConfiguredAgentsFromConfig().map((agent) => ({
    name: agent.name,
    label: agent.label || agent.name,
    source: 'open-cowork' as const,
    mode: agent.mode || 'subagent',
    hidden: agent.hidden === true,
    disabled: false,
    color: agent.color || 'accent',
    description: agent.description,
    instructions: createConfiguredAgentPrompt(agent),
    skills: [...(agent.skillNames || [])],
    toolAccess: configuredToolAccess(agent),
    nativeToolIds: configuredAgentNativeToolIds(agent),
    configuredToolIds: configuredAgentConfiguredToolIds(agent),
    model: agent.model ?? null,
    variant: agent.variant ?? null,
    temperature: typeof agent.temperature === 'number' ? agent.temperature : null,
    top_p: typeof agent.top_p === 'number' ? agent.top_p : null,
    steps: typeof agent.steps === 'number' ? agent.steps : null,
  }))
}

function applyBuiltInDetailOverride(detail: BuiltInAgentDetail): BuiltInAgentDetail {
  const override = builtInOverride(detail.name as 'build' | 'plan' | 'general' | 'explore')
  if (!override) return detail
  return {
    ...detail,
    hidden: override.hidden === true ? true : detail.hidden,
    disabled: override.disable === true,
    description: override.description ?? detail.description,
    color: override.color ?? detail.color,
    model: override.model ?? detail.model ?? null,
    variant: override.variant ?? detail.variant ?? null,
    temperature: typeof override.temperature === 'number' ? override.temperature : detail.temperature ?? null,
    top_p: typeof override.top_p === 'number' ? override.top_p : detail.top_p ?? null,
    steps: typeof override.steps === 'number' ? override.steps : detail.steps ?? null,
  }
}

export function listBuiltInAgentDetails(): BuiltInAgentDetail[] {
  const configuredToolIds = getConfiguredToolsFromConfig().map((tool) => tool.id)
  const buildNativeToolIds = getNativeToolIdsForBuiltInAgent('build')
  const planNativeToolIds = getNativeToolIdsForBuiltInAgent('plan')
  const generalNativeToolIds = getNativeToolIdsForBuiltInAgent('general')
  const exploreNativeToolIds = getNativeToolIdsForBuiltInAgent('explore')

  const coreDetails: BuiltInAgentDetail[] = [
    {
      name: 'build',
      label: 'Build',
      source: 'opencode',
      mode: 'primary',
      hidden: false,
      disabled: false,
      color: 'primary',
      description: 'Default full-access agent for building, editing, and shipping work.',
      instructions: '',
      skills: [],
      toolAccess: [...nativeToolLabels(buildNativeToolIds), ...configuredToolLabels(configuredToolIds)],
      nativeToolIds: buildNativeToolIds,
      configuredToolIds,
    },
    {
      name: 'plan',
      label: 'Plan',
      source: 'opencode',
      mode: 'primary',
      hidden: false,
      disabled: false,
      color: 'warning',
      description: 'Read-only planning and audit agent for decomposition, review, and recommendations.',
      instructions: '',
      skills: [],
      toolAccess: nativeToolLabels(planNativeToolIds),
      nativeToolIds: planNativeToolIds,
      configuredToolIds: [],
    },
    {
      name: 'general',
      label: 'General',
      source: 'opencode',
      mode: 'subagent',
      hidden: false,
      disabled: false,
      color: 'secondary',
      description: 'General-purpose delegated agent for focused subproblems.',
      instructions: '',
      skills: [],
      toolAccess: [...nativeToolLabels(generalNativeToolIds), ...configuredToolLabels(configuredToolIds)],
      nativeToolIds: generalNativeToolIds,
      configuredToolIds,
    },
    {
      name: 'explore',
      label: 'Explore',
      source: 'opencode',
      mode: 'subagent',
      hidden: false,
      disabled: false,
      color: 'accent',
      description: 'Read-only codebase and file-system investigation agent.',
      instructions: '',
      skills: [],
      toolAccess: nativeToolLabels(exploreNativeToolIds),
      nativeToolIds: exploreNativeToolIds,
      configuredToolIds: [],
    },
  ]

  return [
    ...coreDetails.map(applyBuiltInDetailOverride),
    ...getConfiguredBuiltInAgentDetails(),
  ]
}

export function buildOpenCoworkAgentConfig(options: {
  allToolPatterns: string[]
  allowToolPatterns?: string[]
  askToolPatterns?: string[]
  managedSkillNames?: string[]
  availableSkillNames?: string[]
  allowBash?: boolean
  allowEdits?: boolean
  customAgents?: RuntimeCustomAgent[]
}) {
  const globalAccess = getGlobalToolAccess()
  const managedSkillNames = Array.from(new Set([
    ...(options.managedSkillNames || getConfiguredSkillsFromConfig().map((skill) => skill.sourceName)),
  ]))
  const globalSkillRules = Object.fromEntries(managedSkillNames.map((skillName) => [skillName, 'allow' as const]))
  const availableSkillNames = new Set(options.availableSkillNames || managedSkillNames)
  const customAgents = options.customAgents || []
  const configuredAgents = getConfiguredAgentsFromConfig()
  const customTaskRules = Object.fromEntries(customAgents.map((agent) => [agent.name, 'allow' as const]))
  const readonlyCustomTaskRules = Object.fromEntries(customAgents
    .filter((agent) => !agent.writeAccess)
    .map((agent) => [agent.name, 'allow' as const]))
  const configuredTaskRules = Object.fromEntries(configuredAgents
    .filter((agent) => (agent.mode || 'subagent') === 'subagent')
    .map((agent) => [agent.name, 'allow' as const]))

  const allowPatterns = Array.from(new Set([...(options.allowToolPatterns || []), ...globalAccess.allow]))
  const askPatterns = Array.from(new Set([...(options.askToolPatterns || []), ...globalAccess.ask]))
  const allToolPatterns = Array.from(new Set([...options.allToolPatterns, ...globalAccess.all]))

  const agents: Record<string, AgentConfig> = {}

  const builtInDefinitions: Array<{
    name: 'build' | 'plan' | 'general' | 'explore'
    config: AgentConfig
  }> = [
    {
      name: 'build',
      config: {
        mode: 'primary',
        description: 'Default full-access agent for building, editing, and shipping work.',
        color: 'primary',
        permission: createPermissionConfig({
          allToolPatterns,
          allowPatterns,
          askPatterns,
          skillRules: globalSkillRules,
          allowWeb: true,
          allowQuestion: true,
          allowTodoWrite: true,
          allowBash: options.allowBash,
          allowEdits: options.allowEdits,
          taskRules: {
            general: 'allow',
            explore: 'allow',
            ...configuredTaskRules,
            ...customTaskRules,
          },
        }),
      },
    },
    {
      name: 'plan',
      config: {
        mode: 'primary',
        description: 'Read-only planning and audit agent.',
        color: 'warning',
        permission: createPermissionConfig({
          allToolPatterns,
          allowPatterns,
          skillRules: globalSkillRules,
          allowWeb: true,
          askBash: true,
          taskRules: {
            explore: 'allow',
            ...readonlyCustomTaskRules,
          },
        }),
      },
    },
    {
      name: 'general',
      config: {
        mode: 'subagent',
        description: 'General-purpose delegated agent for focused subproblems.',
        color: 'secondary',
        permission: createPermissionConfig({
          allToolPatterns,
          allowPatterns,
          askPatterns,
          skillRules: globalSkillRules,
          allowWeb: true,
          allowQuestion: true,
          allowBash: options.allowBash,
          allowEdits: options.allowEdits,
        }),
      },
    },
    {
      name: 'explore',
      config: {
        mode: 'subagent',
        description: 'Read-only codebase and file-system investigation agent.',
        color: 'accent',
        permission: createPermissionConfig({
          allToolPatterns,
          skillRules: globalSkillRules,
        }),
      },
    },
  ]

  for (const { name, config } of builtInDefinitions) {
    const override = builtInOverride(name)
    if (override?.disable === true) continue

    const base: AgentConfig = { ...config }
    if (override?.description) base.description = override.description
    if (override?.color) base.color = override.color
    if (override?.hidden === true) base.hidden = true
    if (override?.instructions) base.prompt = override.instructions

    agents[name] = applyInferenceOverrides(base, override)
  }

  for (const agent of customAgents) {
    const base: AgentConfig = {
      mode: 'subagent',
      description: agent.description,
      color: agent.color,
      prompt: createCustomAgentPrompt(agent),
      permission: createPermissionConfig({
        allToolPatterns,
        allowPatterns: agent.allowPatterns,
        askPatterns: agent.askPatterns,
        deniedPatterns: agent.deniedPatterns,
        skillRules: Object.fromEntries(agent.skillNames.map((skillName) => [skillName, 'allow' as const])),
      }),
    }
    agents[agent.name] = applyInferenceOverrides(base, agent)
  }

  for (const agent of configuredAgents) {
    const filteredSkillNames = (agent.skillNames || []).filter((skillName) => availableSkillNames.has(skillName))
    const base: AgentConfig = {
      mode: agent.mode || 'subagent',
      description: agent.description,
      color: agent.color || 'accent',
      prompt: createConfiguredAgentPrompt({
        ...agent,
        skillNames: filteredSkillNames,
      }),
      ...(agent.hidden ? { hidden: true } : {}),
      permission: createPermissionConfig({
        allToolPatterns,
        allowPatterns: configuredAgentAllowPatterns(agent),
        askPatterns: configuredAgentAskPatterns(agent),
        skillRules: Object.fromEntries(filteredSkillNames.map((skillName) => [skillName, 'allow' as const])),
      }),
    }
    agents[agent.name] = applyInferenceOverrides(base, agent)
  }

  return agents
}

export const buildCoworkAgentConfig = buildOpenCoworkAgentConfig

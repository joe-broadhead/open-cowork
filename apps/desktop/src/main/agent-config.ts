import {
  getConfiguredAgentsFromConfig,
  getConfiguredToolAllowPatterns,
  getConfiguredToolAskPatterns,
  getConfiguredToolById,
  getConfiguredToolPatterns,
  getConfiguredToolsFromConfig,
  type ConfiguredAgent,
} from './config-loader.ts'
import { configuredToolLabels } from './capability-catalog.ts'
import { getEffectiveSettings } from './settings.ts'

type AgentPermissionOptions = {
  allToolPatterns: string[]
  allowPatterns?: string[]
  askPatterns?: string[]
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
}

export type BuiltInAgentDetail = {
  name: string
  label: string
  source: 'open-cowork' | 'opencode'
  mode: 'primary' | 'subagent'
  hidden: boolean
  color: string
  description: string
  instructions: string
  skills: string[]
  toolAccess: string[]
  nativeToolIds: string[]
  configuredToolIds: string[]
}

function createPermissionConfig(options: AgentPermissionOptions) {
  const permission: Record<string, unknown> = {
    skill: options.skillRules ? { '*': 'deny', ...options.skillRules } : 'allow',
    question: options.allowQuestion ? 'allow' : 'deny',
    task: options.taskRules ? { '*': 'deny', ...options.taskRules } : 'deny',
    todowrite: options.allowTodoWrite ? 'allow' : 'deny',
    codesearch: options.allowWeb ? 'allow' : 'deny',
    webfetch: options.allowWeb ? 'allow' : 'deny',
    websearch: options.allowWeb ? 'allow' : 'deny',
    bash: options.allowBash ? 'allow' : options.askBash ? 'ask' : 'deny',
    edit: options.allowEdits ? 'allow' : 'deny',
    write: options.allowEdits ? 'allow' : 'deny',
    apply_patch: options.allowEdits ? 'allow' : 'deny',
    read: 'allow',
    grep: 'allow',
    glob: 'allow',
    list: 'allow',
  }

  for (const pattern of options.allToolPatterns) permission[pattern] = 'deny'
  for (const pattern of options.askPatterns || []) permission[pattern] = 'ask'
  for (const pattern of options.allowPatterns || []) permission[pattern] = 'allow'

  return permission
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
    ? `Available skills: ${agent.skillNames.join(', ')}`
    : 'No predefined skills are available. Work from your instructions and allowed tools only.'
  const toolLine = agent.toolNames.length > 0
    ? `Allowed tools: ${agent.toolNames.join(', ')}`
    : 'No specific tools are attached to this agent.'

  return [
    `You are ${agent.description}.`,
    'You are a user-defined Open Cowork agent running inside the OpenCode agent system.',
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
    ? `Available skills: ${agent.skillNames.join(', ')}`
    : 'No predefined skills are attached to this agent.'
  const toolLine = configuredToolAccess(agent).length > 0
    ? `Attached tools: ${configuredToolAccess(agent).join(', ')}`
    : 'No dedicated tools are attached to this agent.'

  return [
    `You are ${agent.label || agent.name}.`,
    agent.description,
    toolLine,
    skillLine,
    'You are a built-in Open Cowork agent running inside the OpenCode agent system.',
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
    color: agent.color || 'accent',
    description: agent.description,
    instructions: createConfiguredAgentPrompt(agent),
    skills: [...(agent.skillNames || [])],
    toolAccess: configuredToolAccess(agent),
    nativeToolIds: configuredAgentNativeToolIds(agent),
    configuredToolIds: configuredAgentConfiguredToolIds(agent),
  }))
}

export function listBuiltInAgentDetails(): BuiltInAgentDetail[] {
  const configuredToolIds = getConfiguredToolsFromConfig().map((tool) => tool.id)
  const buildNativeToolIds = getNativeToolIdsForBuiltInAgent('build')
  const planNativeToolIds = getNativeToolIdsForBuiltInAgent('plan')
  const generalNativeToolIds = getNativeToolIdsForBuiltInAgent('general')
  const exploreNativeToolIds = getNativeToolIdsForBuiltInAgent('explore')

  return [
    {
      name: 'build',
      label: 'Build',
      source: 'opencode',
      mode: 'primary',
      hidden: false,
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
      color: 'accent',
      description: 'Read-only codebase and file-system investigation agent.',
      instructions: '',
      skills: [],
      toolAccess: nativeToolLabels(exploreNativeToolIds),
      nativeToolIds: exploreNativeToolIds,
      configuredToolIds: [],
    },
    ...getConfiguredBuiltInAgentDetails(),
  ]
}

export function buildOpenCoworkAgentConfig(options: {
  allToolPatterns: string[]
  allowToolPatterns?: string[]
  askToolPatterns?: string[]
  allowBash?: boolean
  allowEdits?: boolean
  customAgents?: RuntimeCustomAgent[]
}) {
  const globalAccess = getGlobalToolAccess()
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

  const agents: Record<string, any> = {
    build: {
      mode: 'primary',
      description: 'Default full-access agent for building, editing, and shipping work.',
      color: 'primary',
      permission: {
        ...createPermissionConfig({
          allToolPatterns,
          allowPatterns,
          askPatterns,
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
    plan: {
      mode: 'primary',
      description: 'Read-only planning and audit agent.',
      color: 'warning',
      permission: {
        ...createPermissionConfig({
          allToolPatterns,
          allowPatterns,
          allowWeb: true,
          askBash: true,
          taskRules: {
            explore: 'allow',
            ...readonlyCustomTaskRules,
          },
        }),
      },
    },
    general: {
      mode: 'subagent',
      description: 'General-purpose delegated agent for focused subproblems.',
      color: 'secondary',
      permission: {
        ...createPermissionConfig({
          allToolPatterns,
          allowPatterns,
          askPatterns,
          allowWeb: true,
          allowQuestion: true,
          allowBash: options.allowBash,
          allowEdits: options.allowEdits,
        }),
      },
    },
    explore: {
      mode: 'subagent',
      description: 'Read-only codebase and file-system investigation agent.',
      color: 'accent',
      permission: {
        ...createPermissionConfig({
          allToolPatterns,
        }),
      },
    },
  }

  for (const agent of customAgents) {
    agents[agent.name] = {
      mode: 'subagent',
      description: agent.description,
      color: agent.color,
      prompt: createCustomAgentPrompt(agent),
      permission: {
        ...createPermissionConfig({
          allToolPatterns,
          allowPatterns: agent.allowPatterns,
          askPatterns: agent.askPatterns,
          skillRules: Object.fromEntries(agent.skillNames.map((skillName) => [skillName, 'allow' as const])),
        }),
      },
    }
  }

  for (const agent of configuredAgents) {
    agents[agent.name] = {
      mode: agent.mode || 'subagent',
      description: agent.description,
      color: agent.color || 'accent',
      prompt: createConfiguredAgentPrompt(agent),
      ...(agent.hidden ? { hidden: true } : {}),
      permission: {
        ...createPermissionConfig({
          allToolPatterns,
          allowPatterns: configuredAgentAllowPatterns(agent),
          askPatterns: configuredAgentAskPatterns(agent),
          skillRules: Object.fromEntries((agent.skillNames || []).map((skillName) => [skillName, 'allow' as const])),
        }),
      },
    }
  }

  return agents
}

export const buildCoworkAgentConfig = buildOpenCoworkAgentConfig

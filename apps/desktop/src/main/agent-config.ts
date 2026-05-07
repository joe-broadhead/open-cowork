import {
  getConfiguredAgentsFromConfig,
  getConfiguredSkillsFromConfig,
  getConfiguredToolsFromConfig,
} from './config-loader.ts'
import { configuredToolLabels } from './capability-catalog.ts'
import type { AgentConfig } from '@opencode-ai/sdk/v2'
import {
  applyInferenceOverrides,
  createConfiguredAgentPrompt,
  createCustomAgentPrompt,
  createPrimaryAgentPrompt,
  mergeBuiltInPrompt,
  type DelegationPromptAgent,
  type RuntimeCustomAgent,
} from './agent-prompts.ts'
import {
  buildManagedExternalDirectoryRules,
  buildPermissionConfig,
  type PermissionAction,
  type PermissionRuleMap,
} from './permission-config.ts'
import { getAppConfig, getBrandName, type BuiltInAgentOverrideConfig } from './config-loader.ts'
import {
  configuredAgentAllowPatterns,
  configuredAgentAskPatterns,
  configuredAgentConfiguredToolIds,
  configuredAgentMayWrite,
  configuredAgentNativeToolIds,
  configuredToolAccess,
  getGlobalToolAccess,
  getNativeToolIdsForBuiltInAgent,
  hasNativeBashToolPattern,
  hasNativeFileWriteToolPattern,
  hasNativeWebToolPattern,
  nativeToolLabels,
} from './agent-tool-access.ts'

function builtInOverride(name: 'build' | 'plan' | 'general' | 'explore' | 'cowork-exec'): BuiltInAgentOverrideConfig | null {
  if (name === 'cowork-exec') return null
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
  externalDirectoryRules?: Record<string, 'allow' | 'ask' | 'deny'>
  skillRules?: Record<string, 'allow' | 'ask' | 'deny'>
  bash?: PermissionAction
  fileWrite?: PermissionAction
  web?: PermissionAction
  webSearch?: PermissionAction
  requireNativeToolPattern?: boolean
  allowQuestion?: boolean
  allowTodoWrite?: boolean
  task?: PermissionAction
  taskRules?: PermissionRuleMap
}

export type BuiltInAgentDetail = {
  name: string
  label: string
  source: 'open-cowork' | 'opencode'
  mode: 'primary' | 'subagent'
  surface?: 'chat' | 'automation' | 'both'
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
    externalDirectoryRules: options.externalDirectoryRules,
    question: options.allowQuestion ? 'allow' : 'deny',
    task: taskPolicy(options.task || 'deny', options.taskRules),
    todoWrite: options.allowTodoWrite ? 'allow' : 'deny',
    web: options.web || 'deny',
    webSearch: options.webSearch,
    bash: options.bash || 'deny',
    edit: options.fileWrite || 'deny',
    requireNativeToolPattern: options.requireNativeToolPattern,
  })
}

function taskPolicy(policy: PermissionAction, taskRules?: PermissionRuleMap): PermissionAction | PermissionRuleMap {
  if (policy === 'deny') return 'deny'
  if (!taskRules) return policy
  if (policy === 'allow') return taskRules
  const next: PermissionRuleMap = {}
  for (const [name, action] of Object.entries(taskRules)) {
    next[name] = action === 'deny' ? 'deny' : 'ask'
  }
  return next
}

function getConfiguredBuiltInAgentDetails(): BuiltInAgentDetail[] {
  return getConfiguredAgentsFromConfig().map((agent) => ({
    name: agent.name,
    label: agent.label || agent.name,
    source: 'open-cowork' as const,
    mode: agent.mode || 'subagent',
    surface: 'chat' as const,
    hidden: agent.hidden === true,
    disabled: false,
    color: agent.color || 'accent',
    description: agent.description,
    instructions: createConfiguredAgentPrompt(agent, configuredToolAccess(agent)),
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
      surface: 'chat',
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
      surface: 'chat',
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
      surface: 'chat',
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
      surface: 'chat',
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
    {
      name: 'cowork-exec',
      label: 'Cowork Exec',
      source: 'open-cowork',
      mode: 'primary',
      surface: 'automation',
      hidden: true,
      disabled: false,
      color: 'info',
      description: 'Hidden automation supervisor for scheduled work and execution readiness.',
      instructions: 'Automation-only supervisor. Hidden from the normal chat picker.',
      skills: [],
      toolAccess: [...nativeToolLabels(buildNativeToolIds), ...configuredToolLabels(configuredToolIds)],
      nativeToolIds: buildNativeToolIds,
      configuredToolIds,
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
  bash?: PermissionAction
  fileWrite?: PermissionAction
  task?: PermissionAction
  web?: PermissionAction
  webSearch?: PermissionAction
  projectDirectory?: string | null
  customAgents?: RuntimeCustomAgent[]
}) {
  const globalAccess = getGlobalToolAccess()
  const managedSkillNames = Array.from(new Set([
    ...(options.managedSkillNames || getConfiguredSkillsFromConfig().map((skill) => skill.sourceName)),
  ]))
  const customAgents = options.customAgents || []
  const configuredAgents = getConfiguredAgentsFromConfig()
  // Skills are OpenCode-native reusable instructions, not task routing.
  // Keep every configured managed skill visible to built-in agents so a
  // fallback/general child task can still load the right workflow even if
  // the model did not route through the most specific specialist agent.
  const globalSkillRules = Object.fromEntries(managedSkillNames.map((skillName) => [skillName, 'allow' as const]))
  const availableSkillNames = new Set(options.availableSkillNames || managedSkillNames)
  const managedExternalDirectoryRules = buildManagedExternalDirectoryRules({
    skillNames: managedSkillNames,
    projectDirectory: options.projectDirectory,
  })
  const customTaskRules = Object.fromEntries(customAgents.map((agent) => [agent.name, 'allow' as const]))
  const readonlyCustomTaskRules = Object.fromEntries(customAgents
    .filter((agent) => !agent.writeAccess)
    .map((agent) => [agent.name, 'allow' as const]))
  const configuredTaskRules = Object.fromEntries(configuredAgents
    .filter((agent) => (agent.mode || 'subagent') === 'subagent')
    .map((agent) => [agent.name, 'allow' as const]))
  const readonlyConfiguredTaskRules = Object.fromEntries(configuredAgents
    .filter((agent) => (agent.mode || 'subagent') === 'subagent' && !configuredAgentMayWrite(agent))
    .map((agent) => [agent.name, 'allow' as const]))
  const buildDelegatedAgents: DelegationPromptAgent[] = [
    {
      name: 'general',
      description: 'General-purpose delegated agent for focused subproblems.',
      source: 'builtin',
    },
    {
      name: 'explore',
      description: 'Read-only codebase and file-system investigation agent.',
      source: 'builtin',
    },
    ...configuredAgents
      .filter((agent) => (agent.mode || 'subagent') === 'subagent')
      .map((agent) => ({
        name: agent.name,
        description: agent.description,
        source: 'configured' as const,
      })),
    ...customAgents.map((agent) => ({
      name: agent.name,
      description: agent.description,
      source: 'custom' as const,
    })),
  ]
  const planDelegatedAgents: DelegationPromptAgent[] = [
    {
      name: 'explore',
      description: 'Read-only codebase and file-system investigation agent.',
      source: 'builtin',
    },
    ...configuredAgents
      .filter((agent) => (agent.mode || 'subagent') === 'subagent' && !configuredAgentMayWrite(agent))
      .map((agent) => ({
        name: agent.name,
        description: agent.description,
        source: 'configured' as const,
      })),
    ...customAgents
      .filter((agent) => !agent.writeAccess)
      .map((agent) => ({
        name: agent.name,
        description: agent.description,
        source: 'custom' as const,
      })),
  ]

  const allowPatterns = Array.from(new Set([...(options.allowToolPatterns || []), ...globalAccess.allow]))
  const askPatterns = Array.from(new Set([...(options.askToolPatterns || []), ...globalAccess.ask]))
  const allToolPatterns = Array.from(new Set([...options.allToolPatterns, ...globalAccess.all]))
  const appPermissions = getAppConfig().permissions
  const bash = options.bash || 'deny'
  const fileWrite = options.fileWrite || 'deny'
  const task = options.task || appPermissions.task
  const web = options.web || appPermissions.web
  const webSearch = options.webSearch || (appPermissions.webSearch ? web : 'deny')
  const readonlyBash = bash === 'deny' ? 'deny' : 'ask'

  const agents: Record<string, AgentConfig> = {}

  const builtInDefinitions: Array<{
    name: 'build' | 'plan' | 'general' | 'explore' | 'cowork-exec'
    config: AgentConfig
  }> = [
    {
      name: 'build',
      config: {
        mode: 'primary',
        description: 'Default full-access agent for building, editing, and shipping work.',
        color: 'primary',
        prompt: createPrimaryAgentPrompt({
          role: 'build',
          delegatedAgents: buildDelegatedAgents,
        }),
        permission: createPermissionConfig({
          allToolPatterns,
          allowPatterns,
          askPatterns,
          externalDirectoryRules: managedExternalDirectoryRules,
          skillRules: globalSkillRules,
          web,
          webSearch,
          allowQuestion: true,
          allowTodoWrite: true,
          bash,
          fileWrite,
          task,
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
        prompt: createPrimaryAgentPrompt({
          role: 'plan',
          delegatedAgents: planDelegatedAgents,
        }),
        permission: createPermissionConfig({
          allToolPatterns,
          allowPatterns,
          externalDirectoryRules: managedExternalDirectoryRules,
          skillRules: globalSkillRules,
          web,
          webSearch,
          bash: readonlyBash,
          task,
          taskRules: {
            explore: 'allow',
            ...readonlyConfiguredTaskRules,
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
          externalDirectoryRules: managedExternalDirectoryRules,
          skillRules: globalSkillRules,
          web,
          webSearch,
          allowQuestion: true,
          bash,
          fileWrite,
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
          externalDirectoryRules: managedExternalDirectoryRules,
          skillRules: globalSkillRules,
        }),
      },
    },
    {
      name: 'cowork-exec',
      config: {
        mode: 'primary',
        description: 'Automation supervisor for scheduled work, enrichment, and run coordination.',
        color: 'info',
        prompt: [
          `You are the ${getBrandName()} automation executive.`,
          'You supervise durable automations and recurring work.',
          'Do not perform full specialist work yourself when plan/build or a specialist subagent is a better fit.',
          'When a task is incomplete, identify missing context clearly instead of guessing.',
          'When a task is execution-ready, route it into plan/build style work and keep outputs concise and structured.',
        ].join('\n'),
        permission: createPermissionConfig({
          allToolPatterns,
          allowPatterns,
          askPatterns,
          externalDirectoryRules: managedExternalDirectoryRules,
          skillRules: globalSkillRules,
          web,
          webSearch,
          allowQuestion: true,
          allowTodoWrite: true,
          bash,
          fileWrite,
          task,
          taskRules: {
            general: 'allow',
            explore: 'allow',
            ...configuredTaskRules,
            ...customTaskRules,
          },
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
    base.prompt = mergeBuiltInPrompt(base.prompt, override?.instructions)

    agents[name] = applyInferenceOverrides(base, override)
  }

  for (const agent of customAgents) {
    const agentPatterns = [...agent.allowPatterns, ...agent.askPatterns]
    const agentWeb = hasNativeWebToolPattern(agentPatterns) ? web : 'deny'
    const agentBash = agent.writeAccess && hasNativeBashToolPattern(agentPatterns) ? bash : 'deny'
    const agentFileWrite = agent.writeAccess && hasNativeFileWriteToolPattern(agentPatterns) ? fileWrite : 'deny'
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
        externalDirectoryRules: managedExternalDirectoryRules,
        skillRules: Object.fromEntries(agent.skillNames.map((skillName) => [skillName, 'allow' as const])),
        web: agentWeb,
        webSearch: agentWeb === 'deny' ? 'deny' : webSearch,
        bash: agentBash,
        fileWrite: agentFileWrite,
        requireNativeToolPattern: true,
      }),
    }
    agents[agent.name] = applyInferenceOverrides(base, agent)
  }

  for (const agent of configuredAgents) {
    const filteredSkillNames = (agent.skillNames || []).filter((skillName) => availableSkillNames.has(skillName))
    const agentAllowPatterns = configuredAgentAllowPatterns(agent)
    const agentAskPatterns = configuredAgentAskPatterns(agent)
    const agentPatterns = [...agentAllowPatterns, ...agentAskPatterns]
    const agentWeb = hasNativeWebToolPattern(agentPatterns) ? web : 'deny'
    const agentBash = hasNativeBashToolPattern(agentPatterns) ? bash : 'deny'
    const agentFileWrite = hasNativeFileWriteToolPattern(agentPatterns) ? fileWrite : 'deny'
    const base: AgentConfig = {
      mode: agent.mode || 'subagent',
      description: agent.description,
      color: agent.color || 'accent',
      prompt: createConfiguredAgentPrompt({
        ...agent,
        skillNames: filteredSkillNames,
      }, configuredToolAccess(agent)),
      ...(agent.hidden ? { hidden: true } : {}),
      permission: createPermissionConfig({
        allToolPatterns,
        allowPatterns: agentAllowPatterns,
        askPatterns: agentAskPatterns,
        externalDirectoryRules: managedExternalDirectoryRules,
        skillRules: Object.fromEntries(filteredSkillNames.map((skillName) => [skillName, 'allow' as const])),
        web: agentWeb,
        webSearch: agentWeb === 'deny' ? 'deny' : webSearch,
        bash: agentBash,
        fileWrite: agentFileWrite,
        requireNativeToolPattern: true,
      }),
    }
    agents[agent.name] = applyInferenceOverrides(base, agent)
  }

  return agents
}

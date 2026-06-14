import {
  getConfiguredAgentsFromConfig,
  getConfiguredSkillsFromConfig,
} from './config-loader.ts'
import type { AgentConfig } from '@opencode-ai/sdk/v2'
import {
  applyInferenceOverrides,
  createConfiguredAgentPrompt,
  createPrimaryAgentPrompt,
  mergeBuiltInPrompt,
  type DelegationPromptAgent,
} from './agent-prompts.ts'
import type { RuntimeCustomAgent } from './custom-agents-utils.ts'
import { getBuiltInAgentOverride, type BuiltInAgentName } from './built-in-agent-overrides.ts'
import {
  buildManagedExternalDirectoryRules,
  buildPermissionConfig,
  type PermissionAction,
  type PermissionRuleMap,
} from './permission-config.ts'
import { getAppConfig, getBrandName } from './config-loader.ts'
import {
  configuredAgentAllowPatterns,
  configuredAgentAskPatterns,
  configuredAgentMayWrite,
  configuredToolAccess,
  getDefaultAgentToolAccess,
  getGlobalToolAccess,
  hasNativeBashToolPattern,
  hasNativeFileWriteToolPattern,
  hasNativeWebToolPattern,
} from './agent-tool-access.ts'

export type AgentPermissionDescriptor = {
  allToolPatterns: string[]
  allowPatterns?: string[]
  askPatterns?: string[]
  deniedPatterns?: string[]
  externalDirectoryRules?: Record<string, 'allow' | 'ask' | 'deny'>
  allowAllSkills?: boolean
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
  nativeToolPatterns?: string[]
  nativeWriteAccess?: boolean
}

function deriveNativeToolPermission(
  descriptor: AgentPermissionDescriptor,
  requested: PermissionAction | undefined,
  matches: (patterns: string[]) => boolean,
  allowed = true,
): PermissionAction | undefined {
  if (!descriptor.nativeToolPatterns) return requested
  return allowed && matches(descriptor.nativeToolPatterns) ? requested : 'deny'
}

export function buildAgentPermission(descriptor: AgentPermissionDescriptor) {
  const nativeWriteAccess = descriptor.nativeWriteAccess !== false
  const web = deriveNativeToolPermission(descriptor, descriptor.web, hasNativeWebToolPattern)
  const bash = deriveNativeToolPermission(descriptor, descriptor.bash, hasNativeBashToolPattern, nativeWriteAccess)
  const fileWrite = deriveNativeToolPermission(descriptor, descriptor.fileWrite, hasNativeFileWriteToolPattern, nativeWriteAccess)

  return buildPermissionConfig({
    allowAllSkills: descriptor.allowAllSkills === true,
    skillRules: descriptor.skillRules,
    toolPatternsToDeny: descriptor.allToolPatterns,
    allowPatterns: descriptor.allowPatterns,
    askPatterns: descriptor.askPatterns,
    deniedPatterns: descriptor.deniedPatterns,
    externalDirectoryRules: descriptor.externalDirectoryRules,
    question: descriptor.allowQuestion ? 'allow' : 'deny',
    task: taskPolicy(descriptor.task || 'deny', descriptor.taskRules),
    todoWrite: descriptor.allowTodoWrite ? 'allow' : 'deny',
    web: web || 'deny',
    webSearch: web === 'deny' ? 'deny' : descriptor.webSearch,
    bash: bash || 'deny',
    edit: fileWrite || 'deny',
    requireNativeToolPattern: descriptor.requireNativeToolPattern,
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

function isDelegatableCustomAgent(agent: RuntimeCustomAgent) {
  return agent.mode !== 'primary'
}

export function buildOpenCoworkAgentConfig(options: {
  allToolPatterns: string[]
  allowToolPatterns?: string[]
  askToolPatterns?: string[]
  deniedToolPatterns?: string[]
  managedSkillNames?: string[]
  availableSkillNames?: string[]
  bash?: PermissionAction
  fileWrite?: PermissionAction
  task?: PermissionAction
  web?: PermissionAction
  webSearch?: PermissionAction
  projectDirectory?: string | null
  customDelegationAgents?: RuntimeCustomAgent[]
}) {
  const globalAccess = getGlobalToolAccess()
  const defaultAgentAccess = getDefaultAgentToolAccess()
  const managedSkillNames = Array.from(new Set([
    ...(options.managedSkillNames || getConfiguredSkillsFromConfig().map((skill) => skill.sourceName)),
  ]))
  const customDelegationAgents = options.customDelegationAgents || []
  const enabledCustomAgents = customDelegationAgents.filter((agent) => !agent.disabled)
  const configuredAgents = getConfiguredAgentsFromConfig()
  const delegatableConfiguredAgents = configuredAgents.filter((agent) => (agent.mode || 'subagent') === 'subagent')
  const readonlyDelegatableConfiguredAgents = delegatableConfiguredAgents.filter((agent) => !configuredAgentMayWrite(agent))
  const delegatableCustomAgents = enabledCustomAgents.filter(isDelegatableCustomAgent)
  const readonlyDelegatableCustomAgents = delegatableCustomAgents.filter((agent) => !agent.writeAccess)
  // Skills are OpenCode-native reusable instructions, not task routing.
  // Keep every configured managed skill visible to built-in agents so a
  // fallback/general child task can still load the right workflow even if
  // the model did not route through the most specific specialist agent.
  //
  // The SDK `skills.paths` catalog already points at Cowork-managed
  // mirrors containing only the active configured skills. Built-ins can
  // therefore use `skill: "allow"` instead of repeating one allow rule per
  // skill in every built-in agent permission object. This keeps large
  // downstream catalogs from ballooning OpenCode's permission logs while
  // preserving the same product boundary.
  const availableSkillNames = new Set(options.availableSkillNames || managedSkillNames)
  const managedExternalDirectoryRules = buildManagedExternalDirectoryRules({
    skillNames: managedSkillNames,
    projectDirectory: options.projectDirectory,
  })
  const customTaskRules = Object.fromEntries(delegatableCustomAgents
    .map((agent) => [agent.name, 'allow' as const]))
  const readonlyCustomTaskRules = Object.fromEntries(readonlyDelegatableCustomAgents
    .map((agent) => [agent.name, 'allow' as const]))
  const configuredTaskRules = Object.fromEntries(delegatableConfiguredAgents
    .map((agent) => [agent.name, 'allow' as const]))
  const readonlyConfiguredTaskRules = Object.fromEntries(readonlyDelegatableConfiguredAgents
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
    {
      name: 'autoresearch',
      description: 'Measured improvement loops for skills, agents, prompts, and benchmarks.',
      source: 'builtin',
    },
    ...delegatableConfiguredAgents
      .map((agent) => ({
        name: agent.name,
        description: agent.description,
        source: 'configured' as const,
    })),
    ...delegatableCustomAgents
      .map((agent) => ({
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
    ...readonlyDelegatableConfiguredAgents
      .map((agent) => ({
        name: agent.name,
        description: agent.description,
        source: 'configured' as const,
      })),
    ...readonlyDelegatableCustomAgents
      .map((agent) => ({
        name: agent.name,
        description: agent.description,
        source: 'custom' as const,
      })),
  ]
  const chiefOfStaffDelegatedAgents: DelegationPromptAgent[] = [
    {
      name: 'explore',
      description: 'Read-only codebase and file-system investigation agent.',
      source: 'builtin',
    },
    ...readonlyDelegatableConfiguredAgents
      .map((agent) => ({
        name: agent.name,
        description: agent.description,
        source: 'configured' as const,
      })),
    ...readonlyDelegatableCustomAgents
      .map((agent) => ({
        name: agent.name,
        description: agent.description,
        source: 'custom' as const,
      })),
  ]

  const allowPatterns = Array.from(new Set([...(options.allowToolPatterns || []), ...globalAccess.allow]))
  const askPatterns = Array.from(new Set([...(options.askToolPatterns || []), ...globalAccess.ask]))
  const allToolPatterns = Array.from(new Set([...options.allToolPatterns, ...globalAccess.all]))
  const deniedToolPatterns = Array.from(new Set(options.deniedToolPatterns || []))
  const appPermissions = getAppConfig().permissions
  const bash = options.bash || 'deny'
  const fileWrite = options.fileWrite || 'deny'
  const task = options.task || appPermissions.task
  const web = options.web || appPermissions.web
  const webSearch = options.webSearch || (appPermissions.webSearch ? web : 'deny')
  const readonlyBash = bash === 'deny' ? 'deny' : 'ask'

  const agents: Record<string, AgentConfig> = {}

  const builtInDefinitions: Array<{
    name: BuiltInAgentName
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
        permission: buildAgentPermission({
          allToolPatterns,
          allowPatterns,
          askPatterns,
          deniedPatterns: deniedToolPatterns,
          externalDirectoryRules: managedExternalDirectoryRules,
          allowAllSkills: true,
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
            autoresearch: 'allow',
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
        permission: buildAgentPermission({
          allToolPatterns,
          allowPatterns,
          deniedPatterns: deniedToolPatterns,
          externalDirectoryRules: managedExternalDirectoryRules,
          allowAllSkills: true,
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
      name: 'chief-of-staff',
      config: {
        mode: 'primary',
        description: 'Chief-of-Staff planner for turning objectives into specced task drafts and coworker assignments.',
        color: 'info',
        prompt: [
          `You are Cleo, the ${getBrandName()} Chief-of-Staff planner.`,
          'Your job is to turn a human objective into concrete, reviewable task drafts for coworkers.',
          'OpenCode owns execution. Do not implement specialist work inside this planner role when a coworker task should own it.',
          'Use task delegation only for read-only discovery when it materially improves the plan; keep implementation work as assigned coordination tasks.',
          createPrimaryAgentPrompt({
            role: 'plan',
            delegatedAgents: chiefOfStaffDelegatedAgents,
          }),
          'When preparing board task drafts, use the existing CoordinationTask contract: title, spec, assigneeAgent, priority, and column.',
          'Default every new board task to column "planning" unless the user explicitly asks otherwise.',
          'Write specs as complete task briefs with objective context, deliverables, acceptance criteria, constraints, and handoff notes.',
          'Assign tasks to real coworkers or configured agents. Do not assign implementation tasks to Cleo or chief-of-staff.',
          'In normal chat, return structured task drafts and say the board Plan with Cleo action will persist them; do not claim durable CoordinationTask rows were created unless the app reports the coordination service result.',
          'If the objective is ambiguous, ask one concise clarifying question before producing tasks.',
        ].join('\n'),
        permission: buildAgentPermission({
          allToolPatterns,
          allowPatterns,
          deniedPatterns: deniedToolPatterns,
          externalDirectoryRules: managedExternalDirectoryRules,
          allowAllSkills: true,
          web,
          webSearch,
          allowQuestion: true,
          allowTodoWrite: true,
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
        permission: buildAgentPermission({
          allToolPatterns,
          allowPatterns,
          askPatterns,
          deniedPatterns: deniedToolPatterns,
          externalDirectoryRules: managedExternalDirectoryRules,
          allowAllSkills: true,
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
        permission: buildAgentPermission({
          allToolPatterns,
          deniedPatterns: deniedToolPatterns,
          externalDirectoryRules: managedExternalDirectoryRules,
          allowAllSkills: true,
        }),
      },
    },
    {
      name: 'executive-assistant',
      config: {
        mode: 'primary',
        description: 'Executive Assistant for workflow supervision, readiness checks, and run coordination.',
        color: 'info',
        prompt: [
          `You are the ${getBrandName()} Executive Assistant.`,
          'You supervise durable workflows and recurring work.',
          'Do not perform full specialist work yourself when plan/build or a specialist subagent is a better fit.',
          'When a task is incomplete, identify missing context clearly instead of guessing.',
          'When a task is execution-ready, route it into plan/build style work and keep outputs concise and structured.',
        ].join('\n'),
        permission: buildAgentPermission({
          allToolPatterns,
          allowPatterns,
          askPatterns,
          deniedPatterns: deniedToolPatterns,
          externalDirectoryRules: managedExternalDirectoryRules,
          allowAllSkills: true,
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
            autoresearch: 'allow',
            ...configuredTaskRules,
            ...customTaskRules,
          },
        }),
      },
    },
    {
      name: 'autoresearch',
      config: {
        mode: 'subagent',
        description: 'Measured improvement loops for skills, agents, prompts, code paths, and benchmarks.',
        color: 'success',
        prompt: [
          'You are the Open Cowork Autoresearch agent.',
          'Load the autoresearch skill first, then use it as the source of truth for the run.',
          'Before experimenting, confirm the goal, target, mutable scope, read-only scope, metric, direction, verification command or eval protocol, budget, and apply policy.',
          'Run experiments through OpenCode-native tools only. Do not build a separate runner.',
          'Keep one focused mutation per iteration, run comparable verification, keep only measured improvements, and discard regressions.',
          'Use Charts when progress data is useful.',
          'Use Skills to read custom skill bundles and, after approval, save the final improved bundle.',
          'Use Agents to read custom agents, preview improved custom agents, and save only after explicit approval.',
          'For code, benchmark, or built-in skill/agent optimization, preserve unrelated user changes and never stage run artifacts unless the user explicitly asks.',
          'Return a concise summary with baseline, best result, iterations run, kept/discarded changes, verification evidence, and any final skill or agent update awaiting approval.',
        ].join('\n'),
        permission: buildAgentPermission({
          allToolPatterns,
          allowPatterns: [
            'websearch',
            'webfetch',
            'mcp__charts__*',
            'mcp__skills__list_skill_bundles',
            'mcp__skills__get_skill_bundle',
            'mcp__agents__list_agents',
            'mcp__agents__get_agent',
            'mcp__agents__preview_agent',
          ],
          askPatterns: [
            'mcp__skills__save_skill_bundle',
            'mcp__skills__delete_skill_bundle',
            'mcp__agents__save_agent',
            'mcp__agents__delete_agent',
          ],
          deniedPatterns: deniedToolPatterns,
          externalDirectoryRules: managedExternalDirectoryRules,
          skillRules: {
            autoresearch: 'allow',
            'skill-creator': 'allow',
            'agent-creator': 'allow',
          },
          web,
          webSearch,
          allowQuestion: true,
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
    const override = getBuiltInAgentOverride(name)
    if (override?.disable === true) continue

    const base: AgentConfig = { ...config }
    if (override?.description) base.description = override.description
    if (override?.color) base.color = override.color
    if (override?.hidden === true) base.hidden = true
    base.prompt = mergeBuiltInPrompt(base.prompt, override?.instructions)

    agents[name] = applyInferenceOverrides(base, override)
  }

  for (const agent of configuredAgents) {
    const filteredSkillNames = (agent.skillNames || []).filter((skillName) => availableSkillNames.has(skillName))
    const agentAllowPatterns = Array.from(new Set([...configuredAgentAllowPatterns(agent), ...defaultAgentAccess.allow]))
    const agentAskPatterns = configuredAgentAskPatterns(agent)
    const agentPatterns = [...agentAllowPatterns, ...agentAskPatterns]
    const base: AgentConfig = {
      mode: agent.mode || 'subagent',
      description: agent.description,
      color: agent.color || 'accent',
      prompt: createConfiguredAgentPrompt({
        ...agent,
        skillNames: filteredSkillNames,
      }, configuredToolAccess(agent)),
      ...(agent.hidden ? { hidden: true } : {}),
      permission: buildAgentPermission({
        allToolPatterns: Array.from(new Set([...allToolPatterns, ...defaultAgentAccess.all])),
        allowPatterns: agentAllowPatterns,
        askPatterns: agentAskPatterns,
        deniedPatterns: deniedToolPatterns,
        externalDirectoryRules: managedExternalDirectoryRules,
        skillRules: Object.fromEntries(filteredSkillNames.map((skillName) => [skillName, 'allow' as const])),
        web,
        webSearch,
        bash,
        fileWrite,
        nativeToolPatterns: agentPatterns,
        requireNativeToolPattern: true,
      }),
    }
    agents[agent.name] = applyInferenceOverrides(base, agent)
  }

  return agents
}

import { COWORK_DELEGATION_RULES, COWORK_EXECUTION_RULES, COWORK_ORCHESTRATION_RULES, COWORK_PARALLEL_RULES, COWORK_TODO_RULES, MAX_TEAM_BRANCHES } from './team-policy.js'
import { getEnabledIntegrationBundles } from './plugin-manager.ts'

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
  integrationNames: string[]
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
  toolScopes: string[]
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

function getBundleAccess() {
  const enabled = getEnabledIntegrationBundles()
  const read = Array.from(new Set(enabled.flatMap((bundle) => (
    bundle.agentAccess?.readToolPatterns?.length
      ? bundle.agentAccess.readToolPatterns
      : bundle.allowedTools
  ))))
  const write = Array.from(new Set(enabled.flatMap((bundle) => bundle.agentAccess?.writeToolPatterns || [])))
  const denied = Array.from(new Set(enabled.flatMap((bundle) => bundle.deniedTools || [])))
  return { read, write, denied }
}

function createAssistantPrompt() {
  return [
    'You are Open Cowork Assistant, the primary orchestrator for user work.',
    'Use the smallest reliable mix of direct actions and sub-agent delegation.',
    '',
    'Operating model:',
    ...COWORK_ORCHESTRATION_RULES.map((rule) => `- ${rule}`),
    ...COWORK_PARALLEL_RULES.map((rule) => `- ${rule}`),
    '',
    'Delegation rules:',
    ...COWORK_DELEGATION_RULES.map((rule) => `- ${rule}`),
    '',
    'Execution rules:',
    ...COWORK_TODO_RULES.map((rule) => `- ${rule}`),
    ...COWORK_EXECUTION_RULES.map((rule) => `- ${rule}`),
  ].join('\n')
}

function createPlanPrompt() {
  return [
    'You are Open Cowork Plan, a read-only planning and audit agent.',
    'Focus on analysis, decomposition, tradeoffs, and recommendations.',
    'You may delegate only to read-only or analysis sub-agents.',
    `Use parallel child tasks only for independent audit branches, with a maximum of ${MAX_TEAM_BRANCHES} concurrent tasks.`,
    'Do not perform write-side effects.',
  ].join('\n')
}

function createResearchPrompt() {
  return [
    'You are Research, a read-only sub-agent for deep research.',
    'Use websearch and webfetch to gather, compare, and synthesize information from strong sources.',
    'Prioritize official documentation, primary sources, and current references whenever possible.',
    'Do not create nested subtasks, todos, or side effects.',
    'Return concise source-backed findings that the parent can merge into a final response.',
  ].join('\n')
}

function createExplorePrompt() {
  return [
    'You are Explore, a read-only sub-agent for local investigation.',
    'Use file-system and search tools to inspect code, configs, and project structure quickly.',
    'Do not modify files or perform write-side effects.',
    'Return concise factual findings to the parent.',
  ].join('\n')
}

function createCustomAgentPrompt(agent: RuntimeCustomAgent) {
  const skillLine = agent.skillNames.length > 0
    ? `Available skills: ${agent.skillNames.join(', ')}`
    : 'No predefined skills are available. Work from your instructions and allowed tools only.'
  const integrationLine = agent.integrationNames.length > 0
    ? `Allowed integrations: ${agent.integrationNames.join(', ')}`
    : 'No integrations are attached to this sub-agent.'

  return [
    `You are ${agent.description}.`,
    'You are a user-defined Open Cowork sub-agent running inside the OpenCode agent system.',
    skillLine,
    integrationLine,
    agent.writeAccess
      ? 'Some selected integrations can create or update external resources. Those write actions require explicit user approval when invoked.'
      : 'Your selected integrations are read-only. Do not attempt writes or side effects.',
    'Do not create nested subtasks.',
    'Return concise structured outputs that the parent agent can merge into the main thread.',
    '',
    'Custom instructions:',
    agent.instructions || 'Follow the mission and selected skills faithfully.',
  ].join('\n')
}

export function listBuiltInAgentDetails(): BuiltInAgentDetail[] {
  return [
    {
      name: 'assistant',
      label: 'Assistant',
      source: 'open-cowork',
      mode: 'primary',
      hidden: false,
      color: 'primary',
      description: 'Primary orchestrator that coordinates work and delegates to the right sub-agents.',
      instructions: createAssistantPrompt(),
      skills: [],
      toolScopes: ['Orchestration', 'Delegation', 'Enabled integrations', 'Optional bash/file tools'],
    },
    {
      name: 'plan',
      label: 'Plan',
      source: 'open-cowork',
      mode: 'primary',
      hidden: false,
      color: 'warning',
      description: 'Read-only planning and audit agent for decomposition, review, and recommendations.',
      instructions: createPlanPrompt(),
      skills: [],
      toolScopes: ['Read-only planning', 'Read-only delegation', 'Web research'],
    },
    {
      name: 'research',
      label: 'Research',
      source: 'open-cowork',
      mode: 'subagent',
      hidden: false,
      color: 'info',
      description: 'Deep read-only research across web sources, docs, and standards.',
      instructions: createResearchPrompt(),
      skills: [],
      toolScopes: ['Web search', 'Web fetch', 'Read-only file/search tools'],
    },
    {
      name: 'explore',
      label: 'Explore',
      source: 'opencode',
      mode: 'subagent',
      hidden: false,
      color: 'accent',
      description: 'Read-only codebase and file-system investigation sub-agent.',
      instructions: createExplorePrompt(),
      skills: [],
      toolScopes: ['Read-only file/search tools'],
    },
  ]
}

export function buildOpenCoworkAgentConfig(options: {
  allToolPatterns: string[]
  allowBash?: boolean
  allowEdits?: boolean
  customAgents?: RuntimeCustomAgent[]
}) {
  const customAgents = options.customAgents || []
  const customTaskRules = Object.fromEntries(customAgents.map((agent) => [agent.name, 'allow' as const]))
  const readonlyCustomTaskRules = Object.fromEntries(customAgents
    .filter((agent) => !agent.writeAccess)
    .map((agent) => [agent.name, 'allow' as const]))
  const bundleAccess = getBundleAccess()
  const readPatterns = bundleAccess.read
  const askPatterns = bundleAccess.write
  const deniedPatterns = bundleAccess.denied
  const allToolPatterns = Array.from(new Set([
    ...options.allToolPatterns,
    ...readPatterns,
    ...askPatterns,
    ...deniedPatterns,
  ]))

  const agents: Record<string, any> = {
    assistant: {
      mode: 'primary',
      description: 'Default Open Cowork orchestrator for generic work and sub-agent delegation.',
      color: 'primary',
      prompt: createAssistantPrompt(),
      permission: {
        ...createPermissionConfig({
          allToolPatterns,
          allowPatterns: readPatterns,
          askPatterns,
          allowQuestion: true,
          allowTodoWrite: true,
          allowBash: options.allowBash,
          allowEdits: options.allowEdits,
          taskRules: {
            research: 'allow',
            explore: 'allow',
            ...customTaskRules,
          },
        }),
      },
    },
    cowork: {
      hidden: true,
      mode: 'primary',
      description: 'Legacy compatibility alias for the assistant agent.',
      color: 'primary',
      prompt: createAssistantPrompt(),
      permission: {
        ...createPermissionConfig({
          allToolPatterns,
          allowPatterns: readPatterns,
          askPatterns,
          allowQuestion: true,
          allowTodoWrite: true,
          allowBash: options.allowBash,
          allowEdits: options.allowEdits,
          taskRules: {
            research: 'allow',
            explore: 'allow',
            ...customTaskRules,
          },
        }),
      },
    },
    plan: {
      mode: 'primary',
      description: 'Read-only planning and audit agent.',
      color: 'warning',
      prompt: createPlanPrompt(),
      permission: {
        ...createPermissionConfig({
          allToolPatterns,
          allowPatterns: readPatterns,
          allowWeb: true,
          askBash: true,
          taskRules: {
            research: 'allow',
            explore: 'allow',
            ...readonlyCustomTaskRules,
          },
        }),
      },
    },
    general: {
      disable: true,
    },
    research: {
      mode: 'subagent',
      description: 'Deep read-only research across web sources, docs, and standards.',
      color: 'info',
      prompt: createResearchPrompt(),
      permission: {
        ...createPermissionConfig({
          allToolPatterns,
          allowPatterns: readPatterns,
          allowWeb: true,
          skillRules: {},
        }),
      },
    },
    explore: {
      description: 'Read-only codebase and file-system investigation sub-agent.',
      color: 'accent',
    },
    build: {
      description: 'Legacy full-access agent. Open Cowork uses the `assistant` primary agent instead.',
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

  return agents
}

export const buildCoworkAgentConfig = buildOpenCoworkAgentConfig

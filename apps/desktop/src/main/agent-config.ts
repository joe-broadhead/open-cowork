import {
  COWORK_DELEGATION_RULES,
  COWORK_EXECUTION_RULES,
  COWORK_ORCHESTRATION_RULES,
  COWORK_PARALLEL_RULES,
  COWORK_TODO_RULES,
  MAX_TEAM_BRANCHES,
} from './team-policy.js'
import { BUILTIN_INTEGRATION_BUNDLES } from './integration-bundles.ts'

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

  for (const pattern of options.allToolPatterns) {
    permission[pattern] = 'deny'
  }

  for (const pattern of options.askPatterns || []) {
    permission[pattern] = 'ask'
  }

  for (const pattern of options.allowPatterns || []) {
    permission[pattern] = 'allow'
  }

  return permission
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

function getBundleAccess(bundleId: string) {
  const bundle = BUILTIN_INTEGRATION_BUNDLES.find((entry) => entry.id === bundleId)
  return {
    read: bundle?.agentAccess?.readToolPatterns || [],
    write: bundle?.agentAccess?.writeToolPatterns || [],
  }
}

function filterPatternsByPrefix(patterns: string[], prefixes: string[]) {
  return patterns.filter((pattern) => prefixes.some((prefix) => pattern.startsWith(prefix)))
}

const GOOGLE_WORKSPACE_ACCESS = getBundleAccess('google-workspace')
const GITHUB_ACCESS = getBundleAccess('github')
const ATLASSIAN_ACCESS = getBundleAccess('atlassian-rovo')
const AMPLITUDE_ACCESS = getBundleAccess('amplitude')

const SHEETS_READ_PATTERNS = [
  ...filterPatternsByPrefix(GOOGLE_WORKSPACE_ACCESS.read, ['mcp__google-sheets__', 'mcp__google-drive__']),
  'mcp__charts__*',
]
const SHEETS_ASK_PATTERNS = ['mcp__google-sheets__*']

const DOCS_READ_PATTERNS = filterPatternsByPrefix(GOOGLE_WORKSPACE_ACCESS.read, ['mcp__google-docs__', 'mcp__google-drive__'])
const DOCS_ASK_PATTERNS = ['mcp__google-docs__*']

const GMAIL_READ_PATTERNS = filterPatternsByPrefix(GOOGLE_WORKSPACE_ACCESS.read, ['mcp__google-gmail__', 'mcp__google-drive__', 'mcp__google-people__'])
const GMAIL_ASK_PATTERNS = ['mcp__google-gmail__*']

export type BuiltInAgentDetail = {
  name: string
  label: string
  source: 'cowork' | 'opencode'
  mode: 'primary' | 'subagent'
  hidden: boolean
  color: string
  description: string
  instructions: string
  skills: string[]
  toolScopes: string[]
}

function createCoworkPrompt() {
  return [
    'You are Cowork, the primary orchestrator for business work.',
    'Your job is to break work into the smallest reliable mix of direct actions and sub-agent delegations.',
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
    'You are Cowork Plan, a read-only planning and audit agent.',
    'Focus on analysis, decomposition, and recommendations.',
    'You may delegate only to read-only or analysis sub-agents.',
    `Use parallel child tasks only for independent audit branches, with a maximum of ${MAX_TEAM_BRANCHES} concurrent tasks.`,
    'Do not modify files, create documents, or send messages.',
    'If an action would produce side effects, stop at a plan or draft recommendation.',
  ].join('\n')
}

function createAnalystPrompt() {
  return [
    'You are Analyst, a sub-agent for data work.',
    'Load the analyst skill before you begin.',
    'Use Nova to identify metrics, validate lineage, run SQL, and produce evidence-backed findings.',
    'Create chart artifacts when a visualization materially improves the result.',
    'Do not handle general web research, product comparisons, standards research, or meeting-prep reading unless the task explicitly requires Nova-backed analysis.',
    'Do not create or share Google Workspace documents directly unless your task explicitly asks for a handoff artifact for another sub-agent.',
    'Return concise structured findings that the parent can merge into a final response.',
  ].join('\n')
}

function createResearchPrompt() {
  return [
    'You are Research, a sub-agent for deep read-only research.',
    'Use websearch and webfetch to gather, compare, and synthesize information from strong sources.',
    'Prioritize official documentation, primary sources, and current references whenever possible.',
    'This agent is for meeting prep, framework comparison, standards research, vendor/product research, and broad topic investigation.',
    'Do not use Nova or analytics workflows unless the task explicitly asks for data analysis from the company datalake.',
    'Do not create documents, sheets, or outbound messages.',
    'Do not create todos, plans, or parallel research streams inside this sub-agent.',
    'Do not create nested subtasks or act like an orchestrator.',
    'Execute the assigned branch directly with the tools already available to you.',
    'Return concise structured findings with source-backed takeaways that the parent can merge into the final response.',
  ].join('\n')
}

function createSheetsBuilderPrompt() {
  return [
    'You are Sheets Builder, a sub-agent for Google Sheets output.',
    'Load the sheets-reporting skill before you begin.',
    'Build or update spreadsheets, tabs, formatting, and charts.',
    'Write actions may trigger approval before they execute. Proceed once approval is granted.',
    'Prefer clear tab names, readable formatting, and chart outputs that match the provided data.',
    'Return the sheet URL, tabs touched, and chart artifacts or metadata to the parent.',
    'Do not send email or perform unrelated analysis.',
  ].join('\n')
}

function createDocsWriterPrompt() {
  return [
    'You are Docs Writer, a sub-agent for Google Docs output.',
    'Load the docs-writing skill before you begin.',
    'Create or update documents with clear structure, headings, tables, and references.',
    'Write actions may trigger approval before they execute. Proceed once approval is granted.',
    'Return the document URL and a brief summary of what was written.',
    'Do not send email or perform unrelated analysis.',
  ].join('\n')
}

function createGmailDrafterPrompt() {
  return [
    'You are Gmail Drafter, a sub-agent for email drafting.',
    'Load the gmail-management skill before you begin.',
    'Prepare draft-ready emails with clear subject lines, concise body copy, and the right links or attachments.',
    'Draft or send actions may trigger approval before they execute. Proceed once approval is granted.',
    'Prefer drafts over sends unless the parent task explicitly requests a send after approval.',
    'Return draft details or the prepared email body to the parent.',
  ].join('\n')
}

function createExplorePrompt() {
  return [
    'You are Explore, OpenCode’s built-in read-only investigation sub-agent.',
    'Use file-system and search tools to inspect code, configs, and project structure quickly.',
    'Answer codebase questions, locate files, trace implementation paths, and summarize findings.',
    'Do not modify files or perform write-side effects.',
    'Return concise factual findings to the parent or user.',
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
    'You are a user-defined Cowork sub-agent running inside the OpenCode agent system.',
    skillLine,
    integrationLine,
    agent.writeAccess
      ? 'Your selected integrations include actions that can create or update external resources. Those write actions require explicit user approval when invoked. Use them only when they are clearly needed for the task.'
      : 'Your selected integrations are read-only. Do not attempt writes, sends, document creation, or other side effects.',
    'Do not create nested subtasks.',
    'Return concise, structured outputs that the parent agent can merge into the main thread.',
    '',
    'Custom instructions:',
    agent.instructions || 'Follow the mission and selected skills faithfully.',
  ].join('\n')
}

export function listBuiltInAgentDetails(): BuiltInAgentDetail[] {
  return [
    {
      name: 'cowork',
      label: 'Cowork',
      source: 'cowork',
      mode: 'primary',
      hidden: false,
      color: 'primary',
      description: 'Primary orchestrator that coordinates work and delegates to the right sub-agents.',
      instructions: createCoworkPrompt(),
      skills: [],
      toolScopes: ['Orchestration', 'Delegation', 'Approved external MCPs', 'Optional bash/file tools'],
    },
    {
      name: 'plan',
      label: 'Plan',
      source: 'cowork',
      mode: 'primary',
      hidden: false,
      color: 'warning',
      description: 'Read-only planning and audit agent for decomposition, review, and recommendations.',
      instructions: createPlanPrompt(),
      skills: [],
      toolScopes: ['Read-only planning', 'Nova + charts', 'Web research', 'Read-only delegation'],
    },
    {
      name: 'analyst',
      label: 'Analyst',
      source: 'cowork',
      mode: 'subagent',
      hidden: false,
      color: 'accent',
      description: 'Analyze metrics, SQL, and evidence-backed findings using Nova.',
      instructions: createAnalystPrompt(),
      skills: ['analyst'],
      toolScopes: ['Nova', 'Charts'],
    },
    {
      name: 'research',
      label: 'Research',
      source: 'cowork',
      mode: 'subagent',
      hidden: false,
      color: 'info',
      description: 'Deep read-only research across web sources, docs, and standards.',
      instructions: createResearchPrompt(),
      skills: [],
      toolScopes: ['Web search', 'Web fetch', 'Perplexity MCP', 'Read-only file/search tools'],
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
    {
      name: 'sheets-builder',
      label: 'Sheets Builder',
      source: 'cowork',
      mode: 'subagent',
      hidden: true,
      color: 'success',
      description: 'Build and format Google Sheets reports and charts.',
      instructions: createSheetsBuilderPrompt(),
      skills: ['sheets-reporting'],
      toolScopes: ['Google Sheets', 'Google Drive', 'Charts'],
    },
    {
      name: 'docs-writer',
      label: 'Docs Writer',
      source: 'cowork',
      mode: 'subagent',
      hidden: true,
      color: 'info',
      description: 'Create structured Google Docs outputs.',
      instructions: createDocsWriterPrompt(),
      skills: ['docs-writing'],
      toolScopes: ['Google Docs', 'Google Drive'],
    },
    {
      name: 'gmail-drafter',
      label: 'Gmail Drafter',
      source: 'cowork',
      mode: 'subagent',
      hidden: true,
      color: 'secondary',
      description: 'Prepare Gmail drafts and outbound communication handoffs.',
      instructions: createGmailDrafterPrompt(),
      skills: ['gmail-management'],
      toolScopes: ['Gmail', 'Google Drive', 'Google People'],
    },
  ]
}

export function buildCoworkAgentConfig(options: {
  allToolPatterns: string[]
  allowBash?: boolean
  allowEdits?: boolean
  customAgents?: RuntimeCustomAgent[]
}) {
  const allToolPatterns = options.allToolPatterns
  const customAgents = options.customAgents || []
  const customTaskRules = Object.fromEntries(customAgents.map((agent) => [agent.name, 'allow' as const]))
  const planCustomTaskRules = Object.fromEntries(customAgents
    .filter((agent) => !agent.writeAccess)
    .map((agent) => [agent.name, 'allow' as const]))

  const agents: Record<string, any> = {
    cowork: {
      mode: 'primary',
      description: 'Default Cowork orchestrator for business tasks and sub-agent delegation.',
      color: 'primary',
      prompt: createCoworkPrompt(),
      permission: {
        ...createPermissionConfig({
          allToolPatterns,
          allowPatterns: [
            ...ATLASSIAN_ACCESS.read,
            ...AMPLITUDE_ACCESS.read,
            ...GITHUB_ACCESS.read,
          ],
          askPatterns: [...GITHUB_ACCESS.write],
          allowQuestion: true,
          allowTodoWrite: true,
          allowBash: options.allowBash,
          allowEdits: options.allowEdits,
          taskRules: {
            analyst: 'allow',
            research: 'allow',
            explore: 'allow',
            'sheets-builder': 'allow',
            'docs-writer': 'allow',
            'gmail-drafter': 'allow',
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
          allowPatterns: ['mcp__nova__*', 'mcp__charts__*'],
          allowWeb: true,
          askBash: true,
          taskRules: {
            analyst: 'allow',
            research: 'allow',
            explore: 'allow',
            ...planCustomTaskRules,
          },
        }),
      },
    },
    general: {
      disable: true,
    },
    analyst: {
      mode: 'subagent',
      description: 'Analyze metrics, SQL, and evidence-backed findings using Nova.',
      color: 'accent',
      prompt: createAnalystPrompt(),
      permission: {
        ...createPermissionConfig({
          allToolPatterns,
          allowPatterns: ['mcp__nova__*', 'mcp__charts__*'],
          skillRules: {
            analyst: 'allow',
          },
        }),
      },
    },
    research: {
      mode: 'subagent',
      description: 'Deep read-only research across web sources, docs, and standards.',
      color: 'info',
      prompt: createResearchPrompt(),
      permission: {
        ...createPermissionConfig({
          allToolPatterns,
          allowPatterns: ['mcp__perplexity__*'],
          allowWeb: true,
          skillRules: {},
        }),
      },
    },
    'sheets-builder': {
      mode: 'subagent',
      hidden: true,
      description: 'Build and format Google Sheets reports and charts.',
      color: 'success',
      prompt: createSheetsBuilderPrompt(),
      permission: {
        ...createPermissionConfig({
          allToolPatterns,
          allowPatterns: SHEETS_READ_PATTERNS,
          askPatterns: SHEETS_ASK_PATTERNS,
          skillRules: {
            'sheets-reporting': 'allow',
          },
        }),
      },
    },
    'docs-writer': {
      mode: 'subagent',
      hidden: true,
      description: 'Create structured Google Docs outputs.',
      color: 'info',
      prompt: createDocsWriterPrompt(),
      permission: {
        ...createPermissionConfig({
          allToolPatterns,
          allowPatterns: DOCS_READ_PATTERNS,
          askPatterns: DOCS_ASK_PATTERNS,
          skillRules: {
            'docs-writing': 'allow',
          },
        }),
      },
    },
    'gmail-drafter': {
      mode: 'subagent',
      hidden: true,
      description: 'Prepare Gmail drafts and outbound communication handoffs.',
      color: 'secondary',
      prompt: createGmailDrafterPrompt(),
      permission: {
        ...createPermissionConfig({
          allToolPatterns,
          allowPatterns: GMAIL_READ_PATTERNS,
          askPatterns: GMAIL_ASK_PATTERNS,
          skillRules: {
            'gmail-management': 'allow',
          },
        }),
      },
    },
    explore: {
      description: 'Read-only codebase and file-system investigation sub-agent.',
      color: 'accent',
    },
    build: {
      description: 'Legacy full-access agent. Cowork uses the `cowork` primary agent instead.',
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

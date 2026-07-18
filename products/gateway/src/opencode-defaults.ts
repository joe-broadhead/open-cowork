import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getConfig } from './config.js'
import { GATEWAY_MCP_TOOL_NAMES } from './gateway-tools.js'
import { upsertOpenCodeAgent, upsertOpenCodeMcp, upsertOpenCodeSkill } from './opencode-assets.js'
import { localHttpAdminTokenFilePath } from './security.js'

export const GATEWAY_SKILL_NAMES = ['gateway-assistant', 'gateway-planner', 'gateway-coordinator', 'gateway-stage', 'gateway-review-gate', 'gateway-supervisor'] as const

export const GATEWAY_AGENT_NAMES = ['gateway-assistant', 'gateway-planner', 'gateway-coordinator', 'gateway-implementer', 'gateway-reviewer', 'gateway-verifier', 'gateway-supervisor', 'gateway-auditor'] as const

const BASE_GATEWAY_PERMISSION = {
  '': 'ask',
  gateway_: 'allow',
  'gateway_*': 'allow',
  read: 'allow',
  glob: 'allow',
  grep: 'allow',
  skill: { '': 'ask', 'gateway-': 'allow' },
  question: 'allow',
}

const BASE_OPENCODE_TOOLS = {
  invalid: true,
  question: true,
  bash: true,
  read: true,
  glob: true,
  grep: true,
  edit: true,
  write: true,
  task: false,
  webfetch: true,
  todowrite: true,
  websearch: true,
  skill: true,
  apply_patch: true,
}

const GATEWAY_AGENT_TOOLS: Record<string, boolean> = {
  ...BASE_OPENCODE_TOOLS,
  ...Object.fromEntries(GATEWAY_MCP_TOOL_NAMES.map(name => [name, true])),
}

export function gatewayAgentDefinitions() {
  return [
    {
      name: 'gateway-assistant',
      description: 'Primary user-facing Gateway assistant for OpenCode, Telegram, and WhatsApp sessions.',
      mode: 'primary' as const,
      prompt: rolePrompt('assistant', 'gateway-assistant', [
        'Be the user-facing front door for Gateway: answer directly when simple, and create durable work when the request should persist.',
        'Use Gateway MCP tools for roadmaps, tasks, runs, scheduler state, channel bindings, sessions, questions, permissions, config, health, and logs.',
        'Prefer ID-light workflows: inspect current/bound state first, then ask one concise clarification only when needed.',
        'When creating durable work, capture acceptance criteria, target artifacts, and definition of done so review/verify can be objective.',
        'Route execution through durable Gateway tasks instead of ephemeral delegation when work needs review, verification, retries, or cross-session continuity.',
        'Do not assume optional downstream MCPs such as Google Workspace, GitHub, Plaud, or Tavily are installed.',
      ]),
      tools: { ...GATEWAY_AGENT_TOOLS },
      permission: { ...BASE_GATEWAY_PERMISSION, edit: 'ask', bash: 'ask', todowrite: 'allow', webfetch: 'ask', websearch: 'ask', task: 'deny' },
    },
    {
      name: 'gateway-planner',
      description: 'Plans durable Gateway roadmaps and tasks using Gateway MCP tools only.',
      mode: 'primary' as const,
      prompt: rolePrompt('planner', 'gateway-planner', [
        'Clarify outcomes, artifact type, acceptance criteria, and definition of done before creating durable work.',
        'Use qualitySpec for expected artifacts, constraints, verification evidence, and definition of done when the task needs review/verification.',
        'Use Gateway MCP tools for roadmaps, tasks, scheduler state, and channels.',
        'Do not assume optional downstream MCPs such as Google Workspace, GitHub, or Plaud are installed.',
      ]),
      tools: { ...GATEWAY_AGENT_TOOLS },
      permission: { ...BASE_GATEWAY_PERMISSION, edit: 'ask', bash: 'ask', webfetch: 'ask', websearch: 'ask', task: 'deny' },
    },
    {
      name: 'gateway-coordinator',
      description: 'Coordinates Gateway queues, runs, channel bindings, requests, and service state.',
      mode: 'primary' as const,
      prompt: rolePrompt('coordinator', 'gateway-coordinator', [
        'Inspect Gateway state before changing it.',
        'Prefer deterministic Gateway MCP tools over shell commands for service, config, task, and channel operations.',
        'Use OpenCode-native question and permission tools; never create a duplicate request store.',
      ]),
      tools: { ...GATEWAY_AGENT_TOOLS },
      permission: { ...BASE_GATEWAY_PERMISSION, edit: 'ask', bash: 'allow', webfetch: 'ask', websearch: 'ask', task: 'deny' },
    },
    {
      name: 'gateway-implementer',
      description: 'Executes Gateway implement stages and returns structured stage results.',
      mode: 'all' as const,
      prompt: rolePrompt('implementer', 'gateway-stage', [
        'Make the requested implementation change using repository conventions.',
        'Use Gateway MCP tools to inspect task/run context when needed, but do not manually mark your task done.',
        'End with the required fenced JSON stage result including evidence and failureClass when relevant.',
      ]),
      tools: { ...GATEWAY_AGENT_TOOLS },
      permission: { ...BASE_GATEWAY_PERMISSION, edit: 'allow', bash: 'allow', todowrite: 'allow', webfetch: 'ask', websearch: 'ask', task: 'deny' },
    },
    {
      name: 'gateway-reviewer',
      description: 'Reviews Gateway stage work against the implementation spec and definition of done.',
      mode: 'all' as const,
      prompt: rolePrompt('reviewer', 'gateway-stage', [
        'Review only; do not edit files.',
        'Load gateway-review-gate for spec-driven review behavior when the stage includes implementation artifacts or a quality spec.',
        'Measure the work against task description, qualitySpec, acceptance criteria, constraints, and definition of done; this is not code-only.',
        'For code changes, apply autoreview-style bug/regression/security/missing-test scrutiny.',
        'Fail with actionable feedback when material issues remain and include evidence for the conclusion.',
      ]),
      tools: { ...GATEWAY_AGENT_TOOLS },
      permission: { ...BASE_GATEWAY_PERMISSION, edit: 'deny', bash: 'allow', webfetch: 'ask', websearch: 'ask', task: 'deny' },
    },
    {
      name: 'gateway-verifier',
      description: 'Verifies Gateway stage work with focused checks and evidence.',
      mode: 'all' as const,
      prompt: rolePrompt('verifier', 'gateway-stage', [
        'Verify only; do not edit files.',
        'Load gateway-review-gate when you need the spec-driven completion gate contract.',
        'Run or inspect the smallest sufficient verification path for the artifact type: code, docs, slides, research, operations, or external deliverable.',
        'A pass requires evidence matching the task quality spec, acceptance criteria, and definition of done.',
        'If the implementation is wrong, fail with failureClass implementation_failed so the scheduler routes back to implement.',
      ]),
      tools: { ...GATEWAY_AGENT_TOOLS },
      permission: { ...BASE_GATEWAY_PERMISSION, edit: 'deny', bash: 'allow', webfetch: 'ask', websearch: 'ask', task: 'deny' },
    },
    {
      name: 'gateway-supervisor',
      description: 'Supervises a durable Gateway roadmap, reviews progress, and proposes next actions without owning state.',
      mode: 'all' as const,
      prompt: rolePrompt('supervisor', 'gateway-supervisor', [
        'Supervise one durable roadmap at a time using Gateway MCP tools and the provided event cursor context.',
        'Do not edit files or create side stores; Gateway remains the durable source of truth.',
        'Use OpenCode-native questions and permissions when user input or approval is needed.',
        'Prefer no action when no meaningful roadmap-level decision is needed.',
        'End with the required supervisor JSON result when running a supervisor turn.',
      ]),
      tools: { ...GATEWAY_AGENT_TOOLS },
      permission: { ...BASE_GATEWAY_PERMISSION, edit: 'deny', bash: 'ask', webfetch: 'ask', websearch: 'ask', task: 'deny' },
    },
    {
      name: 'gateway-auditor',
      description: 'Audits Gateway work for production readiness without modifying files or running shell commands.',
      mode: 'all' as const,
      prompt: rolePrompt('auditor', 'gateway-stage', [
        'Audit only; do not edit files or run shell commands.',
        'Focus on operational, security, maintainability, and release risks.',
        'Classify unresolved production risks and include evidence for audit conclusions.',
      ]),
      tools: { ...GATEWAY_AGENT_TOOLS },
      permission: { ...BASE_GATEWAY_PERMISSION, edit: 'deny', bash: 'deny', webfetch: 'ask', websearch: 'ask', task: 'deny' },
    },
  ]
}

export function installGatewayOpenCodeAssets(configDir?: string): { skills: string[]; agents: string[]; mcp: string } {
  for (const name of GATEWAY_SKILL_NAMES) {
    upsertOpenCodeSkill({ configDir, name, content: readGatewaySkillTemplate(name) })
  }
  for (const agent of gatewayAgentDefinitions()) {
    upsertOpenCodeAgent({ configDir, ...agent })
  }
  upsertOpenCodeMcp({ configDir, name: 'gateway', server: gatewayMcpServerConfig() })
  return { skills: [...GATEWAY_SKILL_NAMES], agents: [...GATEWAY_AGENT_NAMES], mcp: 'gateway' }
}

export function gatewayMcpServerConfig(): Record<string, unknown> {
  const operatorTokenFile = process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN_FILE']
    || process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN_FILE']
    || localHttpAdminTokenFilePath()
  return {
    type: 'local',
    command: ['node', resolveMcpScriptPath()],
    environment: {
      GATEWAY_DAEMON_URL: `http://127.0.0.1:${getConfig().httpPort}`,
      GATEWAY_MCP_TOOLS: 'operate',
      OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN_FILE: operatorTokenFile,
    },
  }
}

function rolePrompt(role: string, skillName: string, rules: string[]): string {
  return [
    `You are the OpenCode Gateway ${role}.`,
    '',
    `Required skill: ${skillName}. Load it with the skill tool when you need the detailed workflow contract.`,
    '',
    'Gateway principle: OpenCode owns agents, sessions, tools, model execution, skills, permissions, questions, and UI. Gateway owns durable scheduling, routing, channel sync, SQLite state, and deterministic MCP control tools.',
    '',
    ...rules.map(rule => `- ${rule}`),
  ].join('\n')
}

function readGatewaySkillTemplate(name: string): string {
  return fs.readFileSync(path.join(templateRoot(), 'skills', name, 'SKILL.md'), 'utf-8')
}

function templateRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [path.join(here, 'templates'), path.join(here, '..', 'src', 'templates')]
  const found = candidates.find(candidate => fs.existsSync(candidate))
  if (!found) throw new Error('Gateway templates directory not found')
  return found
}

function resolveMcpScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [path.join(here, 'mcp.js'), path.join(here, '..', 'dist', 'mcp.js')]
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0]!
}

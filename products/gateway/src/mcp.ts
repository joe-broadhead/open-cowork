#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { pathToFileURL } from 'node:url'
import { getConfigDir } from './config.js'
import { readPackageVersion } from './version.js'
import { buildOperationsCockpit, buildMissionControlDashboardSummary, buildMissionControlDataPlaneV2, formatMissionControlDataPlaneText, formatMissionControlEnvironmentCounts, missionControlWindow, type MissionControlDataPlaneV2, type MissionControlSourceContract } from './mission-control-view-model.js'
import { decideMcpRequestSecurityPolicy } from './security-policy.js'
import { mcpModeAllowsHttpCapability, resolveMcpToolMode, toolEnabledForMode, type McpToolTier } from './mcp-tool-tiers.js'
import { buildGatewayToolCatalog } from './gateway-tools.js'
import { formatTaskCounts } from './task-summary.js'
import { httpCapabilityForRequest, type HttpCapability } from './security.js'
import { readScopedHttpTokenFile } from './secrets-lifecycle.js'

const DAEMON_URL = process.env['GATEWAY_DAEMON_URL'] || 'http://127.0.0.1:4097'
const REQUEST_TIMEOUT_MS = 15000
const OUTPUT_LIMIT = 12000
const ERROR_BODY_LIMIT = 2000
export const MCP_DAEMON_RESPONSE_LIMIT_BYTES = 1024 * 1024
const zStringRecord = <Schema extends z.ZodTypeAny>(schema: Schema) => z.record(z.string(), schema)

export class GatewayDaemonError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'GatewayDaemonError'
  }
}

export async function fetchJSON(method: string, path: string, body?: any): Promise<any> {
  const policy = decideMcpRequestSecurityPolicy({ method, path, body, trustTier: 'local_trusted', principalRef: 'gateway-mcp-local' })
  if (!policy.allowed) throw new GatewayDaemonError(policy.redactedMessage)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { 'X-Gateway-Actor': 'mcp', 'X-Gateway-Request-Surface': 'mcp' }
    if (body) headers['Content-Type'] = 'application/json'
    const capability = daemonCapabilityForPath(method, path)
    if (!mcpModeAllowsHttpCapability(MCP_TOOL_MODE, capability)) {
      throw new GatewayDaemonError(`MCP tool mode ${MCP_TOOL_MODE} cannot call daemon route requiring ${capability} capability: ${method.toUpperCase()} ${path}`)
    }
    const httpToken = daemonTokenForCapability(capability)
    if (httpToken) headers['Authorization'] = `Bearer ${httpToken}`
    const res = await fetch(`${DAEMON_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    const text = await readResponseTextBounded(res)
    const data = parseJSON(text)
    if (!res.ok) {
      const message = data?.error || data?.message || limitText(text || res.statusText, ERROR_BODY_LIMIT)
      throw new GatewayDaemonError(`Gateway daemon returned HTTP ${res.status}: ${message}`, res.status)
    }
    if (!data && text.trim()) {
      throw new GatewayDaemonError(`Gateway daemon returned a non-JSON response for ${method} ${path}: ${limitText(text, ERROR_BODY_LIMIT)}`, res.status)
    }
    return data
  } catch (err: any) {
    if (err instanceof GatewayDaemonError) throw err
    const reason = err?.name === 'AbortError' ? `timed out after ${REQUEST_TIMEOUT_MS}ms` : err?.message || 'connection failed'
    throw new GatewayDaemonError(`Gateway daemon unreachable at ${DAEMON_URL}: ${reason}. Start it with: opencode-gateway start`)
  } finally {
    clearTimeout(timeout)
  }
}

export async function readResponseTextBounded(response: Response, maxBytes = MCP_DAEMON_RESPONSE_LIMIT_BYTES): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new GatewayDaemonError(`Gateway daemon response exceeds ${maxBytes} bytes`, response.status)
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      bytes += value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new GatewayDaemonError(`Gateway daemon response exceeds ${maxBytes} bytes`, response.status)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), bytes).toString('utf8')
}

function parseJSON(text: string): any {
  try { return text ? JSON.parse(text) : {} } catch { return null }
}

export function limitText(text: string, max = OUTPUT_LIMIT): string {
  if (text.length <= max) return text
  return `${text.substring(0, max)}\n\n[truncated ${text.length - max} characters]`
}

export function formatDaemonError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `Gateway error: ${message}`
}

function queryFromArgs(args: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(args)) if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  return params.toString()
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text: limitText(text) }], isError }
}

export async function runTool(fn: () => Promise<string>) {
  try { return textResult(await fn()) }
  catch (err) { return textResult(formatDaemonError(err), true) }
}

export function formatGatewayDashboardText(input: { health: any; taskData: any; sessions: any; questions: any; permissions: any; attention?: any; environments?: any; operationsCockpit?: any; sourceContracts?: MissionControlSourceContract[]; dataPlane?: MissionControlDataPlaneV2 }): string {
  const summary = buildMissionControlDashboardSummary(input)
  const dataPlane = input.dataPlane || (input.sourceContracts?.length
    ? buildMissionControlDataPlaneV2({ sourceContracts: input.sourceContracts, consumers: ['mcp', 'dashboard', 'support'] })
    : undefined)
  let text = '# Gateway Dashboard\n\n'
  text += `Status: ${summary.status}\n`
  text += `Scheduler: ${summary.scheduler}\n`
  text += `Issues (tasks): ${summary.taskCounts}\n`
  text += `Gateway Sessions: ${summary.gatewaySessions}\n`
  if (summary.environments) text += `Environments: ${summary.environments}\n`
  text += `Requests: ${summary.requests}\n\n`
  if (summary.sources) {
    text += `Sources: ${summary.sources.summary}\n`
    const sourceAttention = summary.sources.items.filter(item => item.severity !== 'ok' && item.state !== 'empty')
    if (sourceAttention.length) text += sourceAttention.slice(0, 8).map(item => `- [${item.state}] ${item.key}: ${item.nextAction}`).join('\n') + '\n'
    text += '\n'
  }
  if (dataPlane) text += `${formatMissionControlDataPlaneText(dataPlane).join('\n')}\n\n`
  if (summary.attention) text += `Needs Attention: ${summary.attention}\n\n`
  if (summary.operationsCockpit) {
    text += `Operations Cockpit: ${summary.operationsCockpit.status} — ${summary.operationsCockpit.summary}\n`
    const nonReady = summary.operationsCockpit.items.filter(item => item.status !== 'ready')
    if (nonReady.length) text += nonReady.slice(0, 8).map(item => `- [${item.status}] ${item.id}: ${item.nextAction}`).join('\n') + '\n'
    text += '\n'
  }
  text += '## Active Issues\n\n'
  text += summary.activeIssues.length ? summary.activeIssues.map(task => `- [${task.status}] ${task.priority}: ${task.title} (${task.id}) — ${task.agent} / ${task.currentStage}`).join('\n') : 'No active work.'
  text += '\n\n## Initiatives (roadmaps)\n\n'
  text += summary.initiatives.length ? summary.initiatives.map(roadmap => `- [${roadmap.status}] ${roadmap.priority}: ${roadmap.title} (${roadmap.id})`).join('\n') : 'No active roadmaps.'
  return text
}

export function formatBulkTaskCreateText(result: any): string {
  const tasks = result?.tasks || []
  if (!tasks.length) return 'No tasks created.'
  return `Created ${result?.created || tasks.length} task(s)\n\n${tasks.map((task: any) => `- ${task.title} (${task.id}) — ${task.priority || 'MEDIUM'} / ${(task.pipeline || []).join(' -> ') || task.currentStage || 'implement'}`).join('\n')}`
}

export function formatSchedulerRunOnceText(result: any): string {
  const counts = result?.counts || {}
  const lines = [
    'Scheduler cycle complete.',
    `Tasks: ${formatTaskCounts(counts, { includeCancelled: true })}`,
  ]
  const activeTasks = result?.activeTasks || []
  if (activeTasks.length) lines.push('', 'Active work:', ...activeTasks.map((task: any) => `- [${task.status}] ${task.title} (${task.id}) — ${task.currentStage || 'complete'}`))
  const recentRuns = result?.recentRuns || []
  if (recentRuns.length) lines.push('', 'Recent runs:', ...recentRuns.slice(-5).map((run: any) => `- [${run.status}] ${run.stage}: ${run.sessionId} (${run.id})`))
  return lines.join('\n')
}

export function formatEnvironmentListText(result: any): string {
  const environments = result?.environments || []
  const lines = [`${environments.length} environment(s): ${formatMissionControlEnvironmentCounts(environments)}`]
  if (environments.length) {
    lines.push('', ...environments.map((environment: any) => {
      const runtime = environment.runtimeProfile
      const runtimeText = runtime ? ` / runtime ${runtime.filesystem?.policy || '?'} net=${runtime.network?.mode || '?'} cwd=${runtime.cwd?.redacted || '?'}` : ''
      const diagnostics = Array.isArray(environment.lifecycleDiagnostics) ? environment.lifecycleDiagnostics : []
      const worst = diagnostics.find((row: any) => row.severity === 'critical') || diagnostics.find((row: any) => row.severity === 'warning') || diagnostics[0]
      const diagnosticText = worst ? ` / diagnostic ${worst.severity}:${worst.code}` : ''
      return `- [${environment.status}] ${environment.name || environment.id} (${environment.id}) — ${environment.backend || '?'} / run ${environment.runId || '?'} / cleanup ${environment.cleanup?.state || '?'}${runtimeText}${diagnosticText}`
    }))
  }
  return lines.join('\n')
}

export function formatEnvironmentActionText(result: any): string {
  const environment = result?.environment || {}
  return [
    `${result?.eventType || 'environment.action'}: ${environment.name || environment.id || 'environment'}`,
    `Environment: ${environment.id || '?'}`,
    `Status: ${environment.status || '?'} / cleanup ${environment.cleanup?.state || '?'}`,
    result?.abortedSessionId ? `Aborted session: ${result.abortedSessionId}` : '',
  ].filter(Boolean).join('\n')
}

export function formatEnvironmentReconcileText(result: any): string {
  const summary = result?.reconciliation || result || {}
  const evidence = (summary.evidence || []).slice(0, 10)
  return [`Environment reconciliation complete: checked=${summary.checked || 0} active=${summary.active || 0} retained=${summary.retained || 0} cleanupFailed=${summary.cleanupFailed || 0}`, ...evidence.map((line: string) => `- ${line}`)].join('\n')
}

export const server = new McpServer({ name: 'gateway-proxy', version: readPackageVersion() })

// Tool tiering: GATEWAY_MCP_TOOLS=read|operate|admin bounds which gateway_*
// tools this server exposes (see src/mcp-tool-tiers.ts). Registration-time
// filtering keeps the tool list an agent sees small and honest — a read-tier
// agent never learns config or asset-mutation tools exist. Defaults to operate.
const MCP_TOOL_MODE = resolveMcpToolMode(process.env['GATEWAY_MCP_TOOLS'])
{
  const rawTool = server.tool.bind(server)
  ;(server as { tool: typeof server.tool }).tool = ((name: string, ...rest: unknown[]) => {
    if (!toolEnabledForMode(name, MCP_TOOL_MODE)) return undefined as never
    return (rawTool as (...args: unknown[]) => unknown)(name, ...rest)
  }) as typeof server.tool
}

function daemonCapabilityForPath(method: string, path: string): HttpCapability {
  const url = new URL(path, DAEMON_URL)
  return httpCapabilityForRequest({ method, pathname: url.pathname, search: url.search })
}

function daemonTokenForCapability(capability: HttpCapability): string | undefined {
  if (capability === 'read' || capability === 'webhook') {
    return envToken('OPENCODE_GATEWAY_HTTP_READ_TOKEN')
      || envToken('OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN')
      || envToken('OPENCODE_GATEWAY_HTTP_ASSET_WRITE_TOKEN')
      || envToken('OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN')
  }
  if (capability === 'operator') {
    return envToken('OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN')
      || envToken('OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN')
  }
  if (capability === 'asset_write') {
    return envToken('OPENCODE_GATEWAY_HTTP_ASSET_WRITE_TOKEN')
      || envToken('OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN')
  }
  return envToken('OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN')
}

function envToken(name: string): string | undefined {
  const direct = String(process.env[name] || '').trim()
  if (direct) return direct
  const filePath = String(process.env[`${name}_FILE`] || '').trim()
  if (!filePath) return undefined
  const token = readScopedHttpTokenFile(filePath)
  if (!token) throw new GatewayDaemonError(`Gateway MCP could not safely read the token file configured by ${name}_FILE`)
  return token
}

server.tool('catalog', 'Discover the reachable Gateway MCP tool surface: returns the grouped inventory enabled for this server tier with each tool\'s group, tier, and purpose. Local and deterministic; does not call the daemon.', {},
  async () => runTool(async () => formatReachableGatewayToolCatalogText(MCP_TOOL_MODE)))

export function formatReachableGatewayToolCatalogText(mode: McpToolTier): string {
  const groups = buildGatewayToolCatalog()
    .map(group => ({ ...group, tools: group.tools.filter(tool => toolEnabledForMode(tool.name, mode)) }))
    .filter(group => group.tools.length > 0)
  const total = groups.reduce((sum, group) => sum + group.tools.length, 0)
  const lines = [
    `# Reachable Gateway MCP Tool Catalog (${total} tools)`,
    '',
    `Active tier: ${mode}. Every tool listed below is registered on this server.`,
    'Tools are exposed to OpenCode as `gateway_<name>`.',
  ]
  for (const group of groups) {
    lines.push('', `## ${group.title}`)
    for (const tool of group.tools) lines.push(`- ${tool.qualifiedName} [${tool.tier}]: ${tool.summary}`)
  }
  return lines.join('\n')
}

const taskCreateSchema = {
  title: z.string(),
  description: z.string().optional(),
  roadmapId: z.string().optional(),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
  agent: z.string().optional(),
  agentTeam: z.string().optional(),
  stageProfiles: zStringRecord(z.string()).optional(),
  environment: z.union([z.string(), zStringRecord(z.any())]).optional(),
  pipeline: z.array(z.string()).optional(),
  note: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
  earliestStartAt: z.string().optional(),
  deadlineAt: z.string().optional(),
  recurrence: z.string().optional(),
  manualGate: z.enum(['approval_required', 'credentials_required', 'external_dependency', 'waiting_for_user']).optional(),
  slaClass: z.string().optional(),
  qualitySpec: zStringRecord(z.any()).optional(),
  idempotencyKey: z.string().optional(),
  sourceType: z.string().optional(),
}

const taskUpdateSchema = {
  title: z.string().optional(),
  description: z.string().optional(),
  roadmapId: z.string().optional(),
  status: z.enum(['pending', 'done', 'blocked', 'paused', 'cancelled', 'archived']).optional(),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
  agent: z.string().optional(),
  agentTeam: z.string().nullable().optional(),
  stageProfiles: zStringRecord(z.string()).nullable().optional(),
  environment: z.union([z.string(), zStringRecord(z.any())]).nullable().optional(),
  pipeline: z.array(z.string()).optional(),
  currentStage: z.string().optional(),
  note: z.string().optional(),
  earliestStartAt: z.string().optional(),
  deadlineAt: z.string().optional(),
  recurrence: z.string().optional(),
  manualGate: z.enum(['approval_required', 'credentials_required', 'external_dependency', 'waiting_for_user']).optional(),
  slaClass: z.string().optional(),
  qualitySpec: zStringRecord(z.any()).optional(),
}

const roadmapSupervisorCreateSchema = {
  roadmapId: z.string(),
  sessionId: z.string(),
  profile: z.string().optional(),
  status: z.enum(['active', 'paused', 'blocked', 'completed']).optional(),
  isDefault: z.boolean().optional(),
  cadence: zStringRecord(z.any()).optional(),
  eventTriggers: zStringRecord(z.any()).optional(),
  lastReviewedEventId: z.number().optional(),
  lastReviewAt: z.string().optional(),
  nextReviewAt: z.string().optional(),
  completionPolicy: zStringRecord(z.any()).optional(),
  notificationPolicyRef: z.string().optional(),
  note: z.string().optional(),
}

const roadmapSupervisorUpdateSchema = {
  sessionId: z.string().optional(),
  profile: z.string().optional(),
  status: z.enum(['active', 'paused', 'blocked', 'completed']).optional(),
  isDefault: z.boolean().optional(),
  cadence: zStringRecord(z.any()).optional(),
  eventTriggers: zStringRecord(z.any()).optional(),
  lastReviewedEventId: z.number().nullable().optional(),
  lastReviewAt: z.string().nullable().optional(),
  nextReviewAt: z.string().nullable().optional(),
  completionPolicy: zStringRecord(z.any()).optional(),
  notificationPolicyRef: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
}

const roadmapQualitySpecSchema = z.object({
  objective: z.string().optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  definitionOfDone: z.array(z.string()).optional(),
  evidenceRequirements: z.array(z.string()).optional(),
  requiredArtifacts: z.array(z.string()).optional(),
  residualRiskNotes: z.array(z.string()).optional(),
  completionPolicy: z.enum(['manual', 'assistant_proposes_user_approves', 'auto_when_evidence_complete', 'never_auto_complete']).optional(),
})

const agentTeamSchema = z.object({
  description: z.string().optional(),
  version: z.string().optional(),
  updatedAt: z.string().optional(),
  promotionState: z.enum(['draft', 'evaluated', 'promoted', 'deprecated', 'blocked']).optional(),
  roles: zStringRecord(z.string()),
  capabilityRequirements: zStringRecord(z.array(z.string())).optional(),
  qualitySpecDefaults: zStringRecord(z.any()).optional(),
})

const agentProfileSchema = z.object({
  version: z.string().optional(),
  updatedAt: z.string().optional(),
  description: z.string().optional(),
  model: z.object({ providerID: z.string(), modelID: z.string(), variant: z.string().optional() }),
  agent: z.string(),
  skills: z.array(z.string()),
  mcpServers: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  permission: zStringRecord(z.string()),
  heartbeatMs: z.number(),
  maxTokens: z.number(),
  role: z.enum(['planning', 'execution']),
  environment: z.union([z.string(), zStringRecord(z.any())]).optional(),
  capabilities: z.array(z.string()).optional(),
  budget: zStringRecord(z.any()).optional(),
  outputContract: zStringRecord(z.any()).optional(),
  promotionState: z.enum(['draft', 'evaluated', 'promoted', 'deprecated', 'blocked']).optional(),
})

const blueprintSchema = z.object({
  name: z.string(),
  version: z.string(),
  metadata: zStringRecord(z.any()).optional(),
  profiles: zStringRecord(agentProfileSchema).optional(),
  teams: zStringRecord(agentTeamSchema).optional(),
  requiredOpenCode: z.object({
    agents: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
    mcpServers: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional(),
  }).optional(),
  expected: z.object({
    profiles: zStringRecord(z.string()).optional(),
    teams: zStringRecord(z.string()).optional(),
  }).optional(),
  permissions: zStringRecord(zStringRecord(z.string())).optional(),
  environments: z.array(z.string()).optional(),
  qualityDefaults: zStringRecord(z.any()).optional(),
  rollback: zStringRecord(z.any()).optional(),
})

const roadmapCompletionProposalSchema = {
  roadmapId: z.string(),
  proposedBy: z.string().optional(),
  sessionId: z.string().optional(),
  evidence: z.array(z.string()).optional(),
  unresolvedRisks: z.array(z.string()).optional(),
  recommendation: z.string().optional(),
  expiresAt: z.string().optional(),
}

const projectBindingSchema = {
  alias: z.string(),
  roadmapId: z.string(),
  sessionId: z.string(),
  scope: z.enum(['global', 'opencode', 'telegram', 'whatsapp', 'discord']).optional(),
  provider: z.string().optional(),
  chatId: z.string().optional(),
  threadId: z.string().optional(),
  title: z.string().optional(),
  allowRebind: z.boolean().optional(),
  notificationMode: z.enum(['immediate', 'digest', 'muted']).optional(),
  mutedUntil: z.string().optional(),
  quietHours: zStringRecord(z.unknown()).optional(),
  lastDigestAt: z.string().optional(),
}

const projectBindingUpdateSchema = {
  alias: z.string().optional(),
  roadmapId: z.string().optional(),
  sessionId: z.string().optional(),
  scope: z.enum(['global', 'opencode', 'telegram', 'whatsapp', 'discord']).optional(),
  provider: z.string().nullable().optional(),
  chatId: z.string().nullable().optional(),
  threadId: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  allowRebind: z.boolean().optional(),
  notificationMode: z.enum(['immediate', 'digest', 'muted']).optional(),
  mutedUntil: z.string().nullable().optional(),
  quietHours: zStringRecord(z.unknown()).nullable().optional(),
  lastDigestAt: z.string().nullable().optional(),
}

const projectContextSchema = {
  alias: z.string().optional(),
  roadmapId: z.string().optional(),
  provider: z.string().optional(),
  chatId: z.string().optional(),
  threadId: z.string().optional(),
  sessionId: z.string().optional(),
}

const projectCreateSchema = {
  alias: z.string(),
  title: z.string().optional(),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
  idempotencyKey: z.string().optional(),
  sourceType: z.string().optional(),
  sessionId: z.string().optional(),
  scope: z.enum(['global', 'opencode', 'telegram', 'whatsapp', 'discord']).optional(),
  provider: z.string().optional(),
  chatId: z.string().optional(),
  threadId: z.string().optional(),
  allowRebind: z.boolean().optional(),
  notificationMode: z.enum(['immediate', 'digest', 'muted']).optional(),
  profile: z.string().optional(),
  agentTeam: z.string().optional(),
  environment: z.any().optional(),
  tasks: z.array(z.union([z.string(), z.object({ title: z.string(), description: z.string().optional(), priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional() })])).optional(),
  qualitySpec: zStringRecord(z.any()).optional(),
}

const promotionSubjectSchema = {
  subjectKind: z.enum(['profile', 'team']),
  subjectName: z.string(),
}

const promotionSubjectOptionalSchema = {
  subjectKind: z.enum(['profile', 'team']).optional(),
  subjectName: z.string().optional(),
}

const teamAssemblyRoleSchema = z.object({
  role: z.string(),
  purpose: z.string().optional(),
  requiredCapabilities: z.array(z.string()).optional(),
  profilePreference: z.string().optional(),
})

const teamAssemblyGrantSchema = z.object({
  role: z.string(),
  skills: z.array(z.string()).optional(),
  mcpServers: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  permission: zStringRecord(z.enum(['allow', 'ask', 'deny'])).optional(),
  reason: z.string().optional(),
})

const teamAssemblySchema = {
  version: z.number().optional(),
  idempotencyKey: z.string(),
  objective: z.string().optional(),
  blueprint: z.union([z.string(), z.object({ name: z.string().optional(), version: z.string().optional() })]).optional(),
  blueprintName: z.string().optional(),
  blueprintVersion: z.string().optional(),
  teamName: z.string().optional(),
  team: z.object({
    preferredTeam: z.string().optional(),
    requiredPromotionState: z.array(z.enum(['draft', 'evaluated', 'promoted', 'deprecated', 'blocked'])).optional(),
    roles: z.array(teamAssemblyRoleSchema).optional(),
  }).optional(),
  roles: z.array(teamAssemblyRoleSchema).optional(),
  grants: z.array(teamAssemblyGrantSchema).optional(),
  requiredPromotionState: z.array(z.enum(['draft', 'evaluated', 'promoted', 'deprecated', 'blocked'])).optional(),
  budget: zStringRecord(z.any()).optional(),
  gates: z.array(zStringRecord(z.any())).optional(),
  evidenceRequirements: z.array(zStringRecord(z.any())).optional(),
}

const teamAssignmentCreateSchema = {
  ...teamAssemblySchema,
  taskId: z.string().optional(),
  roadmapId: z.string().optional(),
  delegationId: z.string().optional(),
  runId: z.string().optional(),
  sessionId: z.string().optional(),
  scope: z.object({
    skills: z.array(z.string()).optional(),
    mcpServers: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional(),
    permissions: zStringRecord(z.enum(['allow', 'ask', 'deny'])).optional(),
  }).optional(),
  requiredEvidence: z.array(zStringRecord(z.any())).optional(),
}

const teamAssignmentListSchema = {
  receiptId: z.string().optional(),
  taskId: z.string().optional(),
  roadmapId: z.string().optional(),
  runId: z.string().optional(),
  sessionId: z.string().optional(),
  memberId: z.string().optional(),
  limit: z.number().optional(),
}

const teamAssignmentReceiptSchema = {
  assignmentId: z.string(),
  receiptKind: z.enum(['gate_result', 'review_outcome', 'completion']),
  gateId: z.string().optional(),
  gateType: z.enum(['review', 'evidence', 'eval', 'human_approval', 'completion_quality']).optional(),
  status: z.enum(['pending', 'passed', 'failed', 'blocked', 'approved', 'rejected']),
  summary: z.string(),
  evidence: z.array(z.string()).optional(),
  reviewer: z.string().optional(),
  runId: z.string().optional(),
  sessionId: z.string().optional(),
  source: z.string().optional(),
  metadata: zStringRecord(z.any()).optional(),
}

server.tool('dashboard', 'Show the Gateway dashboard: durable Issues (tasks), Initiatives (roadmaps), runs, Gateway OpenCode sessions, and pending OpenCode requests.', {},
  async () => {
    return runTool(async () => {
      const [health, taskData, sessions, questions, permissions, attention, environments, readiness] = await Promise.all([
        fetchJSON('GET', '/gateway/health'),
        fetchJSON('GET', '/tasks'),
        fetchJSON('GET', '/session-state').catch(() => ({ sessions: [], counts: { running: 0, total: 0 } })),
        fetchJSON('GET', '/questions').catch(() => ({ questions: [] })),
        fetchJSON('GET', '/permissions').catch(() => ({ permissions: [] })),
        fetchJSON('GET', '/attention').catch(() => ({ attention: undefined })),
        fetchJSON('GET', '/environments').catch(() => ({ environments: [] })),
        fetchJSON('GET', '/readiness').catch((err: any) => ({ state: 'not_ready', summary: err?.message || String(err), checks: [] })),
      ])
      const operationsCockpit = buildOperationsCockpit({ readiness })
      const sourceContracts = [
        missionControlWindow('tasks', taskData?.tasks || [], {}, true).contract,
        missionControlWindow('runs', taskData?.runs || [], {}, true).contract,
        missionControlWindow('sessions', sessions?.sessions || [], {}, true).contract,
        missionControlWindow('environments', environments?.environments || [], {}, true).contract,
        missionControlWindow('gates', [...(questions?.questions || []), ...(permissions?.permissions || [])], {}, true).contract,
      ]
      const dataPlane = buildMissionControlDataPlaneV2({ sourceContracts, consumers: ['mcp', 'dashboard', 'support'] })
      return formatGatewayDashboardText({ health, taskData, sessions, questions, permissions, attention, environments, operationsCockpit, sourceContracts, dataPlane })
    })
  })

server.tool('observability', "Show full observability: Gateway sessions, token usage, costs, per-agent breakdown.", {},
  async () => {
    return runTool(async () => {
      const fs = await import('node:fs')
      const path = await import('node:path')

      const sessions = await fetchJSON('GET', '/session-state')
      const snapshot = await fetchJSON('GET', '/observability').catch(() => null)
      const obsDir = path.join(getConfigDir(), 'observability')
      let text = `# Observability Report\n\n**Gateway Sessions**: ${sessions.counts.total} total (${sessions.counts.running} running)\n`
      if (snapshot?.metrics) {
        text += `**Alerts**: ${snapshot.metrics.alerts.active} active (${snapshot.metrics.alerts.critical} critical)\n`
        text += `**Runs**: ${snapshot.metrics.runs.total} total | ${snapshot.metrics.runs.failedLastHour} failed last hour | avg ${snapshot.metrics.runs.averageRuntimeMs}ms\n`
        if (snapshot.metrics.environments) text += `**Environments**: ${snapshot.metrics.environments.active} active | ${snapshot.metrics.environments.retained} retained | ${snapshot.metrics.environments.cleanupFailed} cleanup failed\n`
        text += `**Cost**: $${Number(snapshot.metrics.cost.totalUsd || 0).toFixed(4)} | ${Number(snapshot.metrics.cost.tokens || 0).toLocaleString()} tokens\n`
      }
      if (snapshot?.supervisors?.summary) {
        const s = snapshot.supervisors.summary
        text += `**Supervisors**: ${s.total || 0} total | ${s.active || 0} active | ${s.due || 0} due | ${s.leased || 0} leased | ${s.stale || 0} stale\n`
      }

      // Read executions
      const execFile = path.join(obsDir, 'executions.jsonl')
      if (fs.existsSync(execFile)) {
        const lines = fs.readFileSync(execFile, 'utf-8').split('\n').filter(Boolean)
        const traces = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
        const totalCost = traces.reduce((s: number, t: any) => s + t.cost, 0)
        const totalTokens = traces.reduce((s: number, t: any) => s + t.tokens.input + t.tokens.output + t.tokens.reasoning, 0)

        text += `\n**Completed**: ${traces.length} | Total cost: $${totalCost.toFixed(4)} | Total tokens: ${totalTokens.toLocaleString()}\n`
        text += `\nLast 10 executions:\n`
        for (const t of traces.slice(-10)) {
          text += `- [${t.status}] ${t.stage || 'simple'} | ${t.title.substring(0, 40)} | $${t.cost.toFixed(4)} | ${t.tokens.input.toLocaleString()} tok\n`
        }
      }

      // Read bottlenecks
      const bnFile = path.join(obsDir, 'bottlenecks.md')
      if (fs.existsSync(bnFile)) text += '\n---\n\n' + fs.readFileSync(bnFile, 'utf-8').substring(0, 2000)
      return text
    })
  })

server.tool('health', 'Get Gateway daemon health, scheduler config, and queue counts.', {},
  async () => runTool(async () => JSON.stringify(await fetchJSON('GET', '/gateway/health'), null, 2)))

server.tool('doctor', 'Run a deterministic Gateway diagnostic report.', {},
  async () => runTool(async () => JSON.stringify(await fetchJSON('GET', '/doctor'), null, 2)))

server.tool('readiness', 'Show local operating readiness state, checks, and operating mode.', {},
  async () => runTool(async () => {
    const { formatReadinessText } = await import('./readiness.js')
    return formatReadinessText(await fetchJSON('GET', '/readiness'))
  }))

server.tool('governance', 'Show budget, quota, token, cost, and runtime governance status.', {},
  async () => runTool(async () => {
    const { formatGovernanceReport } = await import('./governance.js')
    const data = await fetchJSON('GET', '/governance')
    return formatGovernanceReport(data.governance)
  }))

server.tool('analytics_summary', 'Run-history analytics for a bounded window: spend/usage by profile, agent, or roadmap, outcome distribution, retry hotspots, and budget trend. Read-only SQL aggregates.', {
  window: z.number().optional(), since: z.number().optional(), until: z.number().optional(),
  by: z.enum(['profile', 'agent', 'roadmap']).optional(), roadmapId: z.string().optional(),
  profile: z.string().optional(), agent: z.string().optional(), stage: z.string().optional(),
  limit: z.number().optional(), json: z.boolean().optional(),
},
  async (args: { window?: number; since?: number; until?: number; by?: string; roadmapId?: string; profile?: string; agent?: string; stage?: string; limit?: number; json?: boolean }) => runTool(async () => {
    const { formatAnalyticsSummaryText } = await import('./analytics.js')
    const params = new URLSearchParams()
    if (args.window !== undefined) params.set('window', String(args.window))
    if (args.since !== undefined) params.set('since', String(args.since))
    if (args.until !== undefined) params.set('until', String(args.until))
    if (args.by) params.set('by', args.by)
    if (args.roadmapId) params.set('roadmapId', args.roadmapId)
    if (args.profile) params.set('profile', args.profile)
    if (args.agent) params.set('agent', args.agent)
    if (args.stage) params.set('stage', args.stage)
    if (args.limit !== undefined) params.set('limit', String(args.limit))
    const data = await fetchJSON('GET', `/analytics${params.size ? `?${params}` : ''}`)
    return args.json ? JSON.stringify(data.analytics, null, 2) : formatAnalyticsSummaryText(data.analytics)
  }))

server.tool('analytics_scorecard', 'Completion + cost scorecard per profile or agent for a bounded window: completion rate, avg attempts, cost-per-completed-task, derived underperformers, plus an errored-run error-class breakdown (operational / external / genuine / unknown cohorts) and the derived genuine-failure-rate that charges only genuine failures against terminal runs. Read-only SQL aggregates.', {
  window: z.number().optional(), since: z.number().optional(), until: z.number().optional(),
  by: z.enum(['profile', 'agent', 'roadmap']).optional(), roadmapId: z.string().optional(),
  profile: z.string().optional(), agent: z.string().optional(), stage: z.string().optional(),
  json: z.boolean().optional(),
},
  async (args: { window?: number; since?: number; until?: number; by?: string; roadmapId?: string; profile?: string; agent?: string; stage?: string; json?: boolean }) => runTool(async () => {
    const { formatAnalyticsScorecardText } = await import('./analytics.js')
    const params = new URLSearchParams({ view: 'scorecard' })
    if (args.window !== undefined) params.set('window', String(args.window))
    if (args.since !== undefined) params.set('since', String(args.since))
    if (args.until !== undefined) params.set('until', String(args.until))
    if (args.by) params.set('by', args.by)
    if (args.roadmapId) params.set('roadmapId', args.roadmapId)
    if (args.profile) params.set('profile', args.profile)
    if (args.agent) params.set('agent', args.agent)
    if (args.stage) params.set('stage', args.stage)
    const data = await fetchJSON('GET', `/analytics?${params}`)
    return args.json ? JSON.stringify(data.analytics, null, 2) : formatAnalyticsScorecardText(data.analytics)
  }))

server.tool('attention', 'Show unified Needs Attention items across Gateway gates, tasks, runs, and OpenCode-native requests.', {},
  async () => runTool(async () => {
    const { formatNeedsAttentionReport } = await import('./human-loop.js')
    const data = await fetchJSON('GET', '/attention')
    return formatNeedsAttentionReport(data.attention)
  }))

server.tool('briefing', 'Show the latest main-agent Gateway briefing: changed work, active runs, blockers, gates, OpenCode requests, completions, delegated work, alerts, supervisor receipts, and next actions.', { limit: z.number().optional(), json: z.boolean().optional() },
  async (args: { limit?: number; json?: boolean }) => runTool(async () => {
    const params = new URLSearchParams()
    if (args.limit !== undefined) params.set('limit', String(args.limit))
    const data = await fetchJSON('GET', `/briefing${params.size ? `?${params}` : ''}`)
    return args.json ? JSON.stringify(data.briefing, null, 2) : data.text
  }))

server.tool('triage', "One read for the operator's current attention set: pending Gateway human gates, OpenCode questions and permission requests, blocked/paused tasks, stale runs, pending completion proposals, and active alerts — composed into a single read-only payload. Start here when you sit down to operate. Use gateway_attention for just gates/tasks, gateway_alerts for just alerts, or gateway_briefing for a narrative changed-work digest.", { json: z.boolean().optional() },
  async (args: { json?: boolean }) => runTool(async () => {
    const { formatTriageReport } = await import('./triage.js')
    const data = await fetchJSON('GET', '/triage')
    return args.json ? JSON.stringify(data.triage, null, 2) : formatTriageReport(data.triage)
  }))

server.tool('alerts', 'Show active Gateway alerts with severity, evidence, and next actions. For the full operator attention set (gates, questions, blocked tasks, stale runs, and alerts together) use gateway_triage.', {},
  async () => runTool(async () => {
    const { formatAlerts } = await import('./alerts.js')
    const data = await fetchJSON('GET', '/alerts')
    return formatAlerts(data.alerts || [])
  }))

server.tool('roadmap_supervisor_observability', 'Show Initiative Supervisor (roadmap supervisor) health, due/leased state, last results, and recent supervisor audit events.', {},
  async () => runTool(async () => {
    const { formatSupervisorObservability } = await import('./supervisor-observability.js')
    const data = await fetchJSON('GET', '/observability')
    return formatSupervisorObservability(data.supervisors || { generatedAt: new Date().toISOString(), summary: { total: 0, active: 0, due: 0, leased: 0, stale: 0, paused: 0, blocked: 0, completed: 0, pendingCompletionProposals: 0, openHumanGates: 0 }, supervisors: [], auditEvents: [] })
  }))

server.tool('alert_action', 'Acknowledge, resolve, or suppress a Gateway alert.', { alertId: z.string(), action: z.enum(['acknowledge', 'resolve', 'suppress']), note: z.string().optional(), suppressMs: z.number().optional() },
  async (args: { alertId: string; action: string; note?: string; suppressMs?: number }) => runTool(async () => JSON.stringify(await fetchJSON('POST', `/alerts/${encodeURIComponent(args.alertId)}/action`, { action: args.action, note: args.note, suppressMs: args.suppressMs }), null, 2)))

server.tool('incident_report', 'Generate a local incident report from alert lifecycle and workflow events.', { alertId: z.string().optional() },
  async (args: { alertId?: string }) => runTool(async () => {
    const path = args.alertId ? `/incident-report?alertId=${encodeURIComponent(args.alertId)}` : '/incident-report'
    const data = await fetchJSON('GET', path)
    return data.report
  }))

server.tool('human_gate_list', 'List Gateway-level human approval gates. OpenCode-native permissions/questions remain separate.', { status: z.enum(['open', 'pending', 'approved', 'rejected', 'timed_out', 'escalated']).optional() },
  async (args: { status?: string }) => runTool(async () => JSON.stringify(await fetchJSON('GET', `/human-gates?status=${encodeURIComponent(args.status || 'open')}`), null, 2)))

server.tool('human_gate_create', 'Create a durable Gateway-level human gate for a task, run, stage, or roadmap decision.', {
  type: z.enum(['task_start', 'stage_transition', 'external_side_effect', 'budget_exception', 'destructive_action', 'credential_use', 'manual']),
  reason: z.string(),
  taskId: z.string().optional(),
  roadmapId: z.string().optional(),
  runId: z.string().optional(),
  stage: z.string().optional(),
  expiresAt: z.string().optional(),
  timeoutAction: z.enum(['remind', 'escalate', 'pause', 'block']).optional(),
},
  async (args: any) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/human-gates', args), null, 2)))

server.tool('human_gate_decide', 'Approve or reject a Gateway-level human gate with once/always scope and audit trail.', { gateId: z.string(), decision: z.enum(['approve', 'reject']), scope: z.enum(['once', 'always']).optional(), note: z.string().optional() },
  async (args: { gateId: string; decision: string; scope?: string; note?: string }) => runTool(async () => JSON.stringify(await fetchJSON('POST', `/human-gates/${encodeURIComponent(args.gateId)}/decision`, { decision: args.decision, scope: args.scope, note: args.note }), null, 2)))

server.tool('logs', 'Read recent Gateway daemon log lines.', { lines: z.number().optional() },
  async (args: { lines?: number }) => runTool(async () => JSON.stringify(await fetchJSON('GET', `/logs?lines=${encodeURIComponent(String(args.lines || 100))}`), null, 2)))

server.tool('config_get', 'Read Gateway configuration with secrets redacted.', { redact: z.boolean().optional() },
  async () => runTool(async () => JSON.stringify(await fetchJSON('GET', '/config?redact=true'), null, 2)))

server.tool('config_update', 'Update Gateway configuration deterministically. Destructive-action approval is required by default: first call returns a gate, then retry with approvedGateId after approval. Pass dryRun=true to preview the affected config sections (redacted) without writing.', { config: zStringRecord(z.any()), approvedGateId: z.string().optional(), dryRun: z.boolean().optional() },
  async (args: { config: Record<string, unknown>; approvedGateId?: string; dryRun?: boolean }) => runTool(async () => JSON.stringify(await fetchJSON('PATCH', '/config', { ...args.config, approvedGateId: args.approvedGateId, dryRun: args.dryRun }), null, 2)))

server.tool('backup_create', 'Create a timestamped Gateway state backup. Refuses active runs and starting dispatches unless allowActiveRuns=true is supplied during an operator-controlled maintenance window.', { label: z.string().optional(), retention: z.number().optional(), allowActiveRuns: z.boolean().optional() },
  async (args: { label?: string; retention?: number; allowActiveRuns?: boolean }) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/storage/backups', args), null, 2)))

server.tool('backup_list', 'List Gateway state backups and verification status.', {},
  async () => runTool(async () => JSON.stringify(await fetchJSON('GET', '/storage/backups'), null, 2)))

server.tool('backup_verify', 'Verify a Gateway state backup checksum, metadata, and SQLite integrity.', { path: z.string() },
  async (args: { path: string }) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/storage/backups/verify', args), null, 2)))

server.tool('recovery_drill', 'Restore a backup into an isolated state directory and prove scheduler, storage, and channel recovery behavior. Writes evidence under recovery-drills/.', { path: z.string().optional(), label: z.string().optional(), outputDir: z.string().optional(), retryLimit: z.number().optional() },
  async (args: { path?: string; label?: string; outputDir?: string; retryLimit?: number }) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/storage/recovery-drills', args), null, 2)))

server.tool('state_export', 'Export Gateway durable state as JSON for audit or machine transfer.', {},
  async () => runTool(async () => JSON.stringify(await fetchJSON('GET', '/storage/export'), null, 2)))

server.tool('restore', 'Restore Gateway state from a verified backup. Requires maintenanceMode=true while daemon is active and destructive-action approval by default. Pass dryRun=true to preview the backup verification and current state that would be replaced without restoring.', { path: z.string(), maintenanceMode: z.boolean().optional(), skipSafetyBackup: z.boolean().optional(), approvedGateId: z.string().optional(), dryRun: z.boolean().optional() },
  async (args: { path: string; maintenanceMode?: boolean; skipSafetyBackup?: boolean; approvedGateId?: string; dryRun?: boolean }) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/storage/restore', args), null, 2)))

server.tool('restart', 'Request Gateway daemon restart. Requires the admin MCP tool tier (admin HTTP capability for non-local requests) and is audited; no human approval gate applies. A service manager must be installed for the daemon to come back automatically.', {},
  async () => runTool(async () => JSON.stringify(await fetchJSON('POST', '/restart', {}), null, 2)))

server.tool('channel_binding_list', 'List Telegram/WhatsApp channel bindings.', {
  provider: z.string().optional(), chatId: z.string().optional(), threadId: z.string().optional(), sessionId: z.string().optional(),
}, async (args: { provider?: string; chatId?: string; threadId?: string; sessionId?: string }) => runTool(async () => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(args)) if (value !== undefined) params.set(key, String(value))
  return JSON.stringify(await fetchJSON('GET', `/channels/bindings${params.size ? `?${params}` : ''}`), null, 2)
}))

server.tool('channel_connector_status', 'List channel connector setup status, redacted prerequisites, and repair diagnostics.', {
  provider: z.string().optional(),
}, async (args: { provider?: string }) => runTool(async () => {
  const params = new URLSearchParams()
  if (args.provider) params.set('provider', args.provider)
  return JSON.stringify(await fetchJSON('GET', `/channels/connectors${params.size ? `?${params}` : ''}`), null, 2)
}))

server.tool('channel_binding_get', 'Get one Telegram/WhatsApp channel binding.', { provider: z.string(), chatId: z.string(), threadId: z.string().optional() },
  async (args: { provider: string; chatId: string; threadId?: string }) => runTool(async () => {
    const params = new URLSearchParams({ provider: args.provider, chatId: args.chatId })
    if (args.threadId !== undefined) params.set('threadId', args.threadId)
    const result = await fetchJSON('GET', `/channels/bindings?${params}`)
    return JSON.stringify({ binding: result.bindings?.[0] || null }, null, 2)
  }))

server.tool('channel_binding_upsert', 'Create or update a Telegram/WhatsApp channel binding.', {
  provider: z.string(), chatId: z.string(), sessionId: z.string(), threadId: z.string().optional(), mode: z.enum(['chat', 'task', 'roadmap']).optional(), roadmapId: z.string().optional(), taskId: z.string().optional(), title: z.string().optional(),
}, async (args: any) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/channels/bindings', args), null, 2)))

server.tool('channel_binding_delete', 'Delete a Telegram/WhatsApp channel binding.', { provider: z.string(), chatId: z.string(), threadId: z.string().optional() },
  async (args: { provider: string; chatId: string; threadId?: string }) => runTool(async () => {
    const params = new URLSearchParams({ provider: args.provider, chatId: args.chatId })
    if (args.threadId !== undefined) params.set('threadId', args.threadId)
    return JSON.stringify(await fetchJSON('DELETE', `/channels/bindings?${params}`), null, 2)
  }))

server.tool('channel_send', 'Send a message to a specific configured channel chat.', { provider: z.string(), chatId: z.string(), text: z.string(), threadId: z.string().optional() },
  async (args: { provider: string; chatId: string; text: string; threadId?: string }) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/channels/send', args), null, 2)))

server.tool('channel_send_to_task', 'Send a message to channels bound to a Gateway task or its roadmap.', { taskId: z.string(), text: z.string() },
  async (args: { taskId: string; text: string }) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/channels/send-to-task', args), null, 2)))

server.tool('channel_send_to_roadmap', 'Send a message to channels bound to a Gateway roadmap.', { roadmapId: z.string(), text: z.string() },
  async (args: { roadmapId: string; text: string }) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/channels/send-to-roadmap', args), null, 2)))

server.tool('roadmap_create', 'Create a durable Initiative (roadmap) in the Gateway work database.', { title: z.string(), priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(), agentTeam: z.string().optional(), environment: z.union([z.string(), zStringRecord(z.any())]).optional(), qualitySpec: roadmapQualitySpecSchema.optional() },
  async (args: { title: string; priority?: 'HIGH' | 'MEDIUM' | 'LOW' }) => {
    return runTool(async () => {
      const result = await fetchJSON('POST', '/roadmaps', args)
      const r = result.roadmap
      return `Roadmap created: ${r.title}\nID: ${r.id}\nPriority: ${r.priority}`
    })
  })

server.tool('delegation_submit', 'Accept a DelegationRequest v1 and create/replay durable Gateway work with idempotent receipt.', { request: zStringRecord(z.any()) },
  async (args: { request: Record<string, unknown> }) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/delegations', args.request), null, 2)))

server.tool('roadmap_list', 'List durable Initiatives (roadmaps) from the Gateway work database.', {},
  async () => {
    return runTool(async () => {
      const result = await fetchJSON('GET', '/roadmaps')
      const lines = (result.roadmaps || []).map((r: any) => `[${r.status}] ${r.priority}: ${r.title} (${r.id})`)
      return lines.join('\n') || 'No roadmaps.'
    })
  })

server.tool('roadmap_get', 'Get a durable Initiative by roadmap ID.', { roadmapId: z.string() },
  async (args: { roadmapId: string }) => runTool(async () => JSON.stringify(await fetchJSON('GET', `/roadmaps/${encodeURIComponent(args.roadmapId)}`), null, 2)))

server.tool('roadmap_create_with_tasks', 'Create a durable Initiative (roadmap) and child Issues (tasks) atomically. When tasks also need dependency edges or a bound supervisor, use gateway_plan_initiative instead so it stays one atomic call.', {
  title: z.string(),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
  agentTeam: z.string().optional(),
  environment: z.union([z.string(), zStringRecord(z.any())]).optional(),
  qualitySpec: roadmapQualitySpecSchema.optional(),
  tasks: z.array(z.object(taskCreateSchema)).optional(),
}, async (args: any) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/roadmaps/with-tasks', args), null, 2)))

server.tool('plan_initiative', 'Plan a whole Initiative in ONE atomic call: create the roadmap, its Issues (tasks), their dependency edges, and optionally bind a supervisor. Replaces the roadmap_create_with_tasks + N task_dependency_add (+ roadmap_supervisor_create) chain. Each dependency references tasks by 0-based index into tasks[], by new task title, or by an existing task id. All-or-nothing: any bad ref or dependency cycle rolls the entire initiative back so nothing partial persists. Use roadmap_create_with_tasks when there are no dependency edges, or project_create for a channel-bound supervised project.', {
  title: z.string(),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
  agentTeam: z.string().optional(),
  environment: z.union([z.string(), zStringRecord(z.any())]).optional(),
  qualitySpec: roadmapQualitySpecSchema.optional(),
  tasks: z.array(z.object(taskCreateSchema)).optional(),
  dependencies: z.array(z.object({
    taskRef: z.union([z.string(), z.number()]),
    dependsOnRef: z.union([z.string(), z.number()]),
    type: z.enum(['blocks', 'blocked_by', 'parent', 'child', 'related', 'duplicate']).optional(),
  })).optional(),
  supervisor: z.object({
    sessionId: z.string(),
    profile: z.string().optional(),
    isDefault: z.boolean().optional(),
    status: z.enum(['active', 'paused', 'blocked', 'completed']).optional(),
    cadence: zStringRecord(z.any()).optional(),
    eventTriggers: zStringRecord(z.any()).optional(),
    completionPolicy: zStringRecord(z.any()).optional(),
    note: z.string().optional(),
  }).optional(),
}, async (args: any) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/workflows/plan-initiative', args), null, 2)))

server.tool('roadmap_update', 'Update a durable roadmap deterministically.', {
  roadmapId: z.string(),
  title: z.string().optional(),
  status: z.enum(['active', 'done', 'blocked']).optional(),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
  agentTeam: z.string().nullable().optional(),
  environment: z.union([z.string(), zStringRecord(z.any())]).nullable().optional(),
  qualitySpec: roadmapQualitySpecSchema.nullable().optional(),
}, async (args: any) => runTool(async () => {
  const { roadmapId, ...body } = args
  return JSON.stringify(await fetchJSON('PATCH', `/roadmaps/${encodeURIComponent(roadmapId)}`, body), null, 2)
}))

server.tool('roadmap_recompute', 'Recompute a roadmap status from child task states.', { roadmapId: z.string() },
  async (args: { roadmapId: string }) => runTool(async () => JSON.stringify(await fetchJSON('POST', `/roadmaps/${encodeURIComponent(args.roadmapId)}/recompute`), null, 2)))

server.tool('roadmap_memory', 'Show summarized durable roadmap memory: decisions, evidence, failures, and recent task state.', { roadmapId: z.string() },
  async (args: { roadmapId: string }) => runTool(async () => {
    const { formatRoadmapMemory } = await import('./roadmap-memory.js')
    const data = await fetchJSON('GET', `/roadmaps/${encodeURIComponent(args.roadmapId)}/memory`)
    return formatRoadmapMemory(data.memory)
  }))

server.tool('roadmap_completion_proposal_list', 'List roadmap completion proposals.', { roadmapId: z.string().optional(), status: z.enum(['pending', 'approved', 'rejected', 'expired', 'open']).optional() },
  async (args: { roadmapId?: string; status?: string }) => runTool(async () => {
    const params = new URLSearchParams()
    if (args.roadmapId) params.set('roadmapId', args.roadmapId)
    if (args.status) params.set('status', args.status)
    return JSON.stringify(await fetchJSON('GET', `/roadmap-completion-proposals${params.size ? `?${params}` : ''}`), null, 2)
  }))

server.tool('roadmap_completion_proposal_get', 'Get one roadmap completion proposal.', { proposalId: z.string() },
  async (args: { proposalId: string }) => runTool(async () => JSON.stringify(await fetchJSON('GET', `/roadmap-completion-proposals/${encodeURIComponent(args.proposalId)}`), null, 2)))

server.tool('roadmap_completion_propose', 'Propose roadmap completion with evidence and residual risks.', roadmapCompletionProposalSchema,
  async (args: any) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/roadmap-completion-proposals', args), null, 2)))

server.tool('roadmap_completion_decide', 'Approve or reject a pending roadmap completion proposal.', { proposalId: z.string(), decision: z.enum(['approve', 'reject']), actor: z.string().optional(), source: z.string().optional(), note: z.string().optional() },
  async (args: any) => runTool(async () => {
    const { proposalId, ...body } = args
    return JSON.stringify(await fetchJSON('POST', `/roadmap-completion-proposals/${encodeURIComponent(proposalId)}/decision`, body), null, 2)
  }))

server.tool('roadmap_archive', 'Archive a roadmap and its child tasks.', { roadmapId: z.string(), note: z.string().optional() },
  async (args: { roadmapId: string; note?: string }) => runTool(async () => JSON.stringify(await fetchJSON('POST', `/roadmaps/${encodeURIComponent(args.roadmapId)}/archive`, { note: args.note }), null, 2)))

server.tool('roadmap_delete', 'Delete a roadmap and its child tasks/runs. Pass dryRun=true to preview the blast radius (child tasks, runs, supervisors, completion proposals, project bindings, active sessions) without deleting anything.', { roadmapId: z.string(), dryRun: z.boolean().optional() },
  async (args: { roadmapId: string; dryRun?: boolean }) => runTool(async () => JSON.stringify(await fetchJSON('DELETE', `/roadmaps/${encodeURIComponent(args.roadmapId)}${args.dryRun ? '?dryRun=true' : ''}`), null, 2)))

server.tool('roadmap_supervisor_list', 'List durable roadmap supervisors.', { roadmapId: z.string().optional(), status: z.enum(['active', 'paused', 'blocked', 'completed', 'archived']).optional(), includeArchived: z.boolean().optional() },
  async (args: { roadmapId?: string; status?: string; includeArchived?: boolean }) => runTool(async () => {
    const params = new URLSearchParams()
    if (args.roadmapId) params.set('roadmapId', args.roadmapId)
    if (args.status) params.set('status', args.status)
    if (args.includeArchived !== undefined) params.set('includeArchived', String(args.includeArchived))
    return JSON.stringify(await fetchJSON('GET', `/roadmap-supervisors${params.size ? `?${params}` : ''}`), null, 2)
  }))

server.tool('roadmap_supervisor_get', 'Get a durable roadmap supervisor by ID.', { supervisorId: z.string() },
  async (args: { supervisorId: string }) => runTool(async () => JSON.stringify(await fetchJSON('GET', `/roadmap-supervisors/${encodeURIComponent(args.supervisorId)}`), null, 2)))

server.tool('roadmap_supervisor_create', 'Create a durable roadmap supervisor for a roadmap and OpenCode session.', roadmapSupervisorCreateSchema,
  async (args: any) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/roadmap-supervisors', args), null, 2)))

server.tool('roadmap_supervisor_update', 'Update a durable roadmap supervisor deterministically.', { supervisorId: z.string(), ...roadmapSupervisorUpdateSchema },
  async (args: any) => runTool(async () => {
    const { supervisorId, ...body } = args
    return JSON.stringify(await fetchJSON('PATCH', `/roadmap-supervisors/${encodeURIComponent(supervisorId)}`, body), null, 2)
  }))

server.tool('roadmap_supervisor_archive', 'Archive a durable roadmap supervisor.', { supervisorId: z.string(), note: z.string().optional() },
  async (args: { supervisorId: string; note?: string }) => runTool(async () => JSON.stringify(await fetchJSON('POST', `/roadmap-supervisors/${encodeURIComponent(args.supervisorId)}/archive`, { note: args.note }), null, 2)))

server.tool('project_binding_list', 'List durable project aliases and surface bindings.', { alias: z.string().optional(), roadmapId: z.string().optional(), sessionId: z.string().optional(), scope: z.enum(['global', 'opencode', 'telegram', 'whatsapp', 'discord']).optional(), provider: z.string().optional(), chatId: z.string().optional(), threadId: z.string().optional() },
  async (args: any) => runTool(async () => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(args)) if (value !== undefined) params.set(key, String(value))
    return JSON.stringify(await fetchJSON('GET', `/project-bindings${params.size ? `?${params}` : ''}`), null, 2)
  }))

server.tool('project_binding_get', 'Get one durable project binding by ID.', { bindingId: z.string() },
  async (args: { bindingId: string }) => runTool(async () => JSON.stringify(await fetchJSON('GET', `/project-bindings/${encodeURIComponent(args.bindingId)}`), null, 2)))

server.tool('project_binding_upsert', 'Create or explicitly rebind a durable project alias/surface binding.', projectBindingSchema,
  async (args: any) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/project-bindings', args), null, 2)))

server.tool('project_binding_update', 'Update a durable project binding.', { bindingId: z.string(), ...projectBindingUpdateSchema },
  async (args: any) => runTool(async () => {
    const { bindingId, ...body } = args
    return JSON.stringify(await fetchJSON('PATCH', `/project-bindings/${encodeURIComponent(bindingId)}`, body), null, 2)
  }))

server.tool('project_binding_delete', 'Delete a durable project binding and its channel context when applicable.', { bindingId: z.string() },
  async (args: { bindingId: string }) => runTool(async () => JSON.stringify(await fetchJSON('DELETE', `/project-bindings/${encodeURIComponent(args.bindingId)}`), null, 2)))

server.tool('project_context_resolve', 'Resolve current project context by chat/thread, alias, roadmap ID, session, or single active supervisor.', { alias: z.string().optional(), roadmapId: z.string().optional(), provider: z.string().optional(), chatId: z.string().optional(), threadId: z.string().optional(), sessionId: z.string().optional() },
  async (args: any) => runTool(async () => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(args)) if (value !== undefined) params.set(key, String(value))
    return JSON.stringify(await fetchJSON('GET', `/project-bindings/resolve${params.size ? `?${params}` : ''}`), null, 2)
  }))

server.tool('project_create', 'Create a supervised Gateway project with a durable roadmap, default supervisor, and project alias binding.', projectCreateSchema,
  async (args: any) => runTool(async () => {
    const result = await fetchJSON('POST', '/projects', args)
    return result.text || JSON.stringify(result, null, 2)
  }))

server.tool('project_status', 'Show a project status by current context, alias, roadmap ID, chat/thread, or session ID.', projectContextSchema,
  async (args: any) => runTool(async () => {
    const params = queryFromArgs(args)
    const result = await fetchJSON('GET', `/projects/summary${params ? `?${params}` : ''}`)
    return result.text || JSON.stringify(result, null, 2)
  }))

server.tool('project_digest', 'Show recent project events and decisions by current context, alias, roadmap ID, chat/thread, or session ID.', { ...projectContextSchema, limit: z.number().optional() },
  async (args: any) => runTool(async () => {
    const params = queryFromArgs(args)
    const result = await fetchJSON('GET', `/projects/digest${params ? `?${params}` : ''}`)
    return result.text || JSON.stringify(result, null, 2)
  }))

server.tool('project_review_now', 'Queue a roadmap supervisor review for the resolved project without duplicating an already queued review.', projectContextSchema,
  async (args: any) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/projects/review-now', args), null, 2)))

server.tool('project_completion_decide', 'Approve or reject the resolved project completion proposal. proposalId is optional when exactly one proposal is pending.', { ...projectContextSchema, proposalId: z.string().optional(), decision: z.enum(['approve', 'reject']), actor: z.string().optional(), source: z.string().optional(), note: z.string().optional() },
  async (args: any) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/projects/completion-decision', args), null, 2)))

for (const action of ['pause', 'resume'] as const) {
  server.tool(`project_${action}`, `${action} the resolved project's roadmap supervisor.`, { ...projectContextSchema, note: z.string().optional() },
    async (args: any) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/projects/supervisor-action', { ...args, action }), null, 2)))
}

server.tool('task_create', 'Create a durable Issue (task) for the Gateway scheduler.', {
  title: z.string(),
  description: z.string().optional(),
  roadmapId: z.string().optional(),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
  agent: z.string().optional(),
  agentTeam: z.string().optional(),
  stageProfiles: zStringRecord(z.string()).optional(),
  environment: z.union([z.string(), zStringRecord(z.any())]).optional(),
  pipeline: z.array(z.string()).optional(),
  note: z.string().optional(),
  qualitySpec: zStringRecord(z.any()).optional(),
  idempotencyKey: z.string().optional(),
  sourceType: z.string().optional(),
}, async (args: { title: string; description?: string; roadmapId?: string; priority?: 'HIGH' | 'MEDIUM' | 'LOW'; agent?: string; pipeline?: string[]; note?: string; qualitySpec?: Record<string, unknown>; idempotencyKey?: string; sourceType?: string }) => {
  return runTool(async () => {
    const result = await fetchJSON('POST', '/tasks', args)
    const t = result.task
    return `Task created: ${t.title}\nID: ${t.id}\nRoadmap: ${t.roadmapId}\nPipeline: ${(t.pipeline || []).join(' -> ')}`
  })
})

server.tool('task_bulk_create', 'Create durable scheduler tasks atomically.', {
  roadmapId: z.string().optional(),
  tasks: z.array(z.object(taskCreateSchema)),
}, async (args: any) => runTool(async () => formatBulkTaskCreateText(await fetchJSON('POST', '/tasks/bulk', args))))

server.tool('task_list', 'List durable Issues (scheduler tasks) from the Gateway work database.', {},
  async () => {
    return runTool(async () => {
      const result = await fetchJSON('GET', '/tasks')
      const lines = (result.tasks || []).map((t: any) => `[${t.status}] ${t.priority}: ${t.title} (${t.id}) stage=${t.currentStage || 'complete'}`)
      return `${result.counts?.total || 0} task(s)\n\n${lines.join('\n') || 'No tasks.'}`
    })
  })

server.tool('task_get', 'Get a durable Issue by task ID.', { taskId: z.string() },
  async (args: { taskId: string }) => {
    return runTool(async () => {
      const result = await fetchJSON('GET', `/tasks/${encodeURIComponent(args.taskId)}`)
      const t = result.task
      return JSON.stringify(t, null, 2)
    })
  })

server.tool('task_update', 'Update a durable scheduler task deterministically.', {
  taskId: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  roadmapId: z.string().optional(),
  status: z.enum(['pending', 'done', 'blocked', 'paused', 'cancelled', 'archived']).optional(),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
  agent: z.string().optional(),
  agentTeam: z.string().nullable().optional(),
  stageProfiles: zStringRecord(z.string()).nullable().optional(),
  environment: z.union([z.string(), zStringRecord(z.any())]).nullable().optional(),
  pipeline: z.array(z.string()).optional(),
  currentStage: z.string().optional(),
  note: z.string().optional(),
  earliestStartAt: z.string().optional(),
  deadlineAt: z.string().optional(),
  recurrence: z.string().optional(),
  manualGate: z.enum(['approval_required', 'credentials_required', 'external_dependency', 'waiting_for_user']).optional(),
  slaClass: z.string().optional(),
  qualitySpec: zStringRecord(z.any()).optional(),
}, async (args: any) => {
  return runTool(async () => {
    const { taskId, ...body } = args
    const result = await fetchJSON('PATCH', `/tasks/${encodeURIComponent(taskId)}`, body)
    return JSON.stringify(result.task, null, 2)
  })
})

server.tool('task_dependency_list', 'List dependencies and readiness for a durable scheduler task.', { taskId: z.string() },
  async (args: { taskId: string }) => runTool(async () => {
    const [dependencies, readiness] = await Promise.all([
      fetchJSON('GET', `/tasks/${encodeURIComponent(args.taskId)}/dependencies`),
      fetchJSON('GET', `/tasks/${encodeURIComponent(args.taskId)}/readiness`),
    ])
    return JSON.stringify({ ...dependencies, ...readiness }, null, 2)
  }))

server.tool('task_dependency_add', 'Add a deterministic dependency that must be satisfied before a task can run.', {
  taskId: z.string(),
  dependsOnTaskId: z.string(),
  type: z.enum(['blocks', 'blocked_by', 'parent', 'child', 'related', 'duplicate']).optional(),
}, async (args: { taskId: string; dependsOnTaskId: string; type?: string }) => runTool(async () => JSON.stringify(await fetchJSON('POST', `/tasks/${encodeURIComponent(args.taskId)}/dependencies`, { dependsOnTaskId: args.dependsOnTaskId, type: args.type }), null, 2)))

server.tool('task_dependency_delete', 'Delete a task dependency.', {
  taskId: z.string(),
  dependsOnTaskId: z.string(),
  type: z.enum(['blocks', 'blocked_by', 'parent', 'child', 'related', 'duplicate']).optional(),
}, async (args: { taskId: string; dependsOnTaskId: string; type?: string }) => runTool(async () => {
  const params = new URLSearchParams({ dependsOnTaskId: args.dependsOnTaskId })
  if (args.type) params.set('type', args.type)
  return JSON.stringify(await fetchJSON('DELETE', `/tasks/${encodeURIComponent(args.taskId)}/dependencies?${params}`), null, 2)
}))

server.tool('task_bulk_update', 'Update durable scheduler tasks atomically. Pass dryRun=true to preview which tasks would change (and which requested ids are missing) without mutating.', {
  updates: z.array(z.object({ taskId: z.string(), ...taskUpdateSchema })),
  dryRun: z.boolean().optional(),
}, async (args: any) => runTool(async () => JSON.stringify(await fetchJSON('PATCH', '/tasks/bulk', args), null, 2)))

for (const action of ['pause', 'resume', 'cancel', 'retry', 'done', 'block'] as const) {
  server.tool(`task_${action}`, `${action} a durable scheduler task.`, { taskId: z.string(), stage: z.string().optional(), note: z.string().optional() },
    async (args: { taskId: string; stage?: string; note?: string }) => {
      return runTool(async () => {
        const result = await fetchJSON('POST', `/tasks/${encodeURIComponent(args.taskId)}/action`, { action, stage: args.stage, note: args.note })
        return `${action}: ${result.task.title}\nStatus: ${result.task.status}${result.abortedSessionId ? `\nAborted session: ${result.abortedSessionId}` : ''}`
      })
    })
}

server.tool('active_run_list', 'List active Gateway/OpenCode runs with lease owner, heartbeat freshness, cancellability, restartability, and last operator action.', {},
  async () => runTool(activeRunListToolText))

server.tool('active_run_control', 'Apply a lease-safe control to one active run. cancel and stop are terminal; retry/restart requeue durable Gateway work and do not reuse the current OpenCode session.', {
  runId: z.string(),
  action: z.enum(['cancel', 'stop', 'retry', 'restart']),
  expectedLeaseOwner: z.string().optional(),
  expectedSchedulerGeneration: z.string().optional(),
  note: z.string().optional(),
}, async (args: { runId: string; action: string; expectedLeaseOwner?: string; expectedSchedulerGeneration?: string; note?: string }) => runTool(() => activeRunControlToolText(args)))

export async function activeRunListToolText(): Promise<string> {
  const data = await fetchJSON('GET', ['/operator', 'status'].join('/'))
  return JSON.stringify(data.operator?.activeRuns || [], null, 2)
}

export async function activeRunControlToolText(args: { runId: string; action: string; expectedLeaseOwner?: string; expectedSchedulerGeneration?: string; note?: string }): Promise<string> {
  const result = await fetchJSON('POST', `/operator/runs/${encodeURIComponent(args.runId)}/actions`, {
    action: args.action,
    expectedLeaseOwner: args.expectedLeaseOwner,
    expectedSchedulerGeneration: args.expectedSchedulerGeneration,
    note: args.note,
  })
  const control = result.activeRunControl?.control || {}
  return [
    `Run control: ${control.action || args.action}`,
    `Outcome: ${control.outcome || 'unknown'}`,
    `Reason: ${control.reason || 'unknown'}`,
    control.restartBehavior ? `Restart behavior: ${control.restartBehavior}` : '',
    control.abortedSessionId ? `Aborted session: ${control.abortedSessionId}` : '',
    control.nextAction ? `Next: ${control.nextAction}` : '',
  ].filter(Boolean).join('\n')
}

server.tool('artifact_manifest_list', 'List bounded local run artifact manifests with redacted refs, retention policy, redaction status, and availability counts.', {
  runId: z.string().optional(),
  taskId: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
}, async (args: { runId?: string; taskId?: string; limit?: number }) => runTool(() => artifactManifestListToolText(args)))

server.tool('artifact_manifest_get', 'Get one bounded local run artifact manifest by run ID without exposing raw local file paths.', {
  runId: z.string(),
}, async (args: { runId: string }) => runTool(() => artifactManifestGetToolText(args.runId)))

export async function artifactManifestListToolText(args: { runId?: string; taskId?: string; limit?: number } = {}): Promise<string> {
  const query = queryFromArgs(args as Record<string, unknown>)
  const data = await fetchJSON('GET', `/artifacts/manifest${query ? `?${query}` : ''}`)
  const rows = data.artifactManifests || (data.artifactManifest ? [data.artifactManifest] : [])
  if (!rows.length) return 'No artifact manifests.'
  return rows.map(formatArtifactManifestSummary).join('\n\n')
}

export async function artifactManifestGetToolText(runId: string): Promise<string> {
  const data = await fetchJSON('GET', `/artifacts/manifest?runId=${encodeURIComponent(runId)}`)
  return formatArtifactManifestSummary(data.artifactManifest, true)
}

export function formatArtifactManifestSummary(manifest: any, includeEntries = false): string {
  const counts = manifest?.counts || {}
  const lines = [
    `Artifact manifest: ${manifest?.id || 'unknown'}`,
    `Run: ${manifest?.runId || 'unknown'} task=${manifest?.taskId || 'unknown'} stage=${manifest?.stage || 'unknown'}`,
    `Manifest found: ${manifest?.manifestFound ? 'yes' : 'no'} pathHash=${manifest?.manifestPathHash || 'unknown'}`,
    `Entries: available=${counts.available || 0} missing=${counts.missing || 0} unsupported=${counts.unsupported || 0} blocked=${counts.blocked || 0}`,
    `Redaction: ${manifest?.redactionStatus || 'unknown'} retention=${(manifest?.retentionPolicies || []).join(', ') || 'unknown'}`,
    `Workspace: local-only=${manifest?.workspace?.localOnly === true ? 'yes' : 'no'} hosted-collaboration=${manifest?.workspace?.hostedCollaboration === true ? 'yes' : 'no'} inline-limit=${manifest?.workspace?.inlineViewLimitBytes || 'unknown'} bytes`,
  ]
  if (includeEntries && Array.isArray(manifest?.entries)) {
    lines.push('Entries:')
    for (const entry of manifest.entries) {
      lines.push(`- ${entry.id}: ${entry.status} ${entry.filename} ${entry.sizeBytes ?? '?'} bytes ref=${entry.ref} redaction=${entry.redactionStatus} previewSafe=${entry.previewSafe ? 'yes' : 'no'}${entry.omittedReason ? ` omitted=${entry.omittedReason}` : ''}`)
    }
  }
  return lines.join('\n')
}

server.tool('task_archive', 'Archive a durable scheduler task.', { taskId: z.string(), note: z.string().optional() },
  async (args: { taskId: string; note?: string }) => runTool(async () => JSON.stringify(await fetchJSON('POST', `/tasks/${encodeURIComponent(args.taskId)}/archive`, { note: args.note }), null, 2)))

server.tool('task_delete', 'Delete a durable scheduler task and its runs. Pass dryRun=true to preview the blast radius (runs, dependency edges, dependents, active sessions) without deleting anything.', { taskId: z.string(), dryRun: z.boolean().optional() },
  async (args: { taskId: string; dryRun?: boolean }) => runTool(async () => JSON.stringify(await fetchJSON('DELETE', `/tasks/${encodeURIComponent(args.taskId)}${args.dryRun ? '?dryRun=true' : ''}`), null, 2)))

server.tool('run_list', 'List recent scheduler runs.', {},
  async () => {
    return runTool(async () => {
      const result = await fetchJSON('GET', '/runs')
      const lines = (result.runs || []).map((r: any) => `[${r.status}] ${r.stage}: ${r.sessionId} (${r.id}) task=${r.taskId}`)
      return lines.join('\n') || 'No runs.'
    })
  })

server.tool('run_get', 'Get a scheduler run by run ID or OpenCode session ID.', { runId: z.string() },
  async (args: { runId: string }) => {
    return runTool(async () => {
      const result = await fetchJSON('GET', `/runs/${encodeURIComponent(args.runId)}`)
      return JSON.stringify(result.run, null, 2)
    })
  })

server.tool('environment_list', 'List Gateway execution environments with lease, backend, cleanup, and artifact state.', { status: z.string().optional(), backend: z.string().optional(), runId: z.string().optional() },
  async (args: { status?: string; backend?: string; runId?: string }) => runTool(async () => {
    const params = queryFromArgs(args as Record<string, unknown>)
    return formatEnvironmentListText(await fetchJSON('GET', `/environments${params ? `?${params}` : ''}`))
  }))

server.tool('environment_get', 'Inspect one Gateway execution environment by environment ID or run ID.', { environmentId: z.string() },
  async (args: { environmentId: string }) => runTool(async () => JSON.stringify(await fetchJSON('GET', `/environments/${encodeURIComponent(args.environmentId)}`), null, 2)))

server.tool('environment_action', 'Retain, release, abort, or cleanup one Gateway execution environment.', { environmentId: z.string(), action: z.enum(['retain', 'release', 'abort', 'cleanup']), note: z.string().optional() },
  async (args: { environmentId: string; action: string; note?: string }) => runTool(async () => {
    const result = await fetchJSON('POST', `/environments/${encodeURIComponent(args.environmentId)}/action`, { action: args.action, note: args.note, actor: 'mcp' })
    return formatEnvironmentActionText(result)
  }))

server.tool('environment_reconcile', 'Reconcile stale Gateway execution environments and summarize cleanup state.', {},
  async () => runTool(async () => formatEnvironmentReconcileText(await fetchJSON('POST', '/environments/reconcile'))))

server.tool('work_events', 'List recent Gateway-owned workflow events. OpenCode question/permission events remain OpenCode-owned.', { limit: z.number().optional() },
  async (args: { limit?: number }) => {
    return runTool(async () => {
      const result = await fetchJSON('GET', `/events?limit=${encodeURIComponent(String(args.limit || 50))}`)
      const lines = (result.events || []).map((e: any) => `${e.createdAt} ${e.type}${e.subjectId ? ` ${e.subjectId}` : ''}`)
      return lines.join('\n') || 'No workflow events.'
    })
  })

server.tool('scheduler_status', 'Show deterministic scheduler configuration and queue counts.', {},
  async () => runTool(async () => JSON.stringify(await fetchJSON('GET', '/scheduler'), null, 2)))

server.tool('scheduler_pause', 'Pause the Gateway scheduler. Existing OpenCode sessions continue unless their tasks are paused/cancelled.', {},
  async () => runTool(async () => JSON.stringify(await fetchJSON('POST', '/scheduler/pause'), null, 2)))

server.tool('scheduler_resume', 'Resume the Gateway scheduler.', {},
  async () => runTool(async () => JSON.stringify(await fetchJSON('POST', '/scheduler/resume'), null, 2)))

server.tool('scheduler_run_once', 'Run one scheduler cycle immediately. To also ensure a specific task/initiative is eligible (resuming a paused target task) and highlight whether it dispatched, use gateway_dispatch_now.', {},
  async () => runTool(async () => formatSchedulerRunOnceText(await fetchJSON('POST', '/scheduler/run'))))

server.tool('dispatch_now', 'Run a scheduler cycle now, dispatching ALL ready work up to maxConcurrent. HONORS the durable scheduler.enabled state: if the scheduler is paused this is a truthful no-op (schedulerPaused:true, nothing dispatches, no config change) — resume it explicitly with scheduler_resume first. Pass taskId/roadmapId to ensure that target is eligible (resuming a paused target task) and to highlight whether it dispatched via requested/requestedDispatched; the report ALWAYS lists the full dispatched set (dispatched/dispatchedTotal), never just the scoped target. The cycle respects maxConcurrent and run leases, so already-running or leased work is a no-op. Collapses scheduler_run_once + status.', {
  taskId: z.string().optional(),
  roadmapId: z.string().optional(),
}, async (args: { taskId?: string; roadmapId?: string }) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/workflows/dispatch-now', args), null, 2)))

server.tool('scheduler_configure', 'Update scheduler settings deterministically.', {
  enabled: z.boolean().optional(),
  intervalMs: z.number().optional(),
  maxConcurrent: z.number().optional(),
  leaseMs: z.number().optional(),
  retryLimit: z.number().optional(),
  defaultPipeline: z.array(z.string()).optional(),
  stageProfiles: zStringRecord(z.string()).optional(),
  stageConcurrency: zStringRecord(z.number()).optional(),
  profileConcurrency: zStringRecord(z.number()).optional(),
}, async (args: any) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/scheduler', args), null, 2)))

server.tool('question_list', 'List pending OpenCode-native questions.', {},
  async () => runTool(async () => JSON.stringify(await fetchJSON('GET', '/questions'), null, 2)))

server.tool('question_reply', 'Reply to an OpenCode-native question. Answers is an array of answer arrays, one per question.', {
  requestId: z.string(),
  answers: z.array(z.array(z.string())),
}, async (args: { requestId: string; answers: string[][] }) => runTool(async () => JSON.stringify(await fetchJSON('POST', `/questions/${encodeURIComponent(args.requestId)}/reply`, { answers: args.answers }), null, 2)))

server.tool('question_reject', 'Reject an OpenCode-native question.', { requestId: z.string() },
  async (args: { requestId: string }) => runTool(async () => JSON.stringify(await fetchJSON('POST', `/questions/${encodeURIComponent(args.requestId)}/reject`), null, 2)))

server.tool('permission_list', 'List pending OpenCode-native permissions.', {},
  async () => runTool(async () => JSON.stringify(await fetchJSON('GET', '/permissions'), null, 2)))

server.tool('permission_reply', 'Reply to an OpenCode-native permission request.', {
  requestId: z.string(),
  reply: z.enum(['once', 'always', 'reject']),
  message: z.string().optional(),
}, async (args: { requestId: string; reply: 'once' | 'always' | 'reject'; message?: string }) => runTool(async () => JSON.stringify(await fetchJSON('POST', `/permissions/${encodeURIComponent(args.requestId)}/reply`, { reply: args.reply, message: args.message }), null, 2)))

server.tool('permission_reject', 'Reject an OpenCode-native permission request without granting shell/edit capability.', {
  requestId: z.string(),
  message: z.string().optional(),
}, async (args: { requestId: string; message?: string }) => runTool(async () => JSON.stringify(await fetchJSON('POST', `/permissions/${encodeURIComponent(args.requestId)}/reject`, { message: args.message }), null, 2)))

server.tool('opencode_session_list', 'List OpenCode sessions. Non-admin tiers are limited to Gateway-owned sessions.', {
  gatewayOnly: MCP_TOOL_MODE === 'admin' ? z.boolean().optional() : z.literal(true).optional(),
  limit: z.number().int().min(1).max(500).optional(),
},
  async (args: { gatewayOnly?: boolean; limit?: number }) => runTool(async () => {
    const params = new URLSearchParams()
    if (args.gatewayOnly !== undefined) params.set('gatewayOnly', String(args.gatewayOnly))
    if (args.limit !== undefined) params.set('limit', String(args.limit))
    return JSON.stringify(await fetchJSON('GET', `/opencode/sessions${params.size ? `?${params}` : ''}`), null, 2)
  }))

server.tool('opencode_session_get', 'Get an OpenCode session and Web/TUI links.', { sessionId: z.string() },
  async (args: { sessionId: string }) => runTool(async () => JSON.stringify(await fetchJSON('GET', `/opencode/sessions/${encodeURIComponent(args.sessionId)}`), null, 2)))

server.tool('opencode_session_messages', 'Get recent messages from an OpenCode session.', { sessionId: z.string(), limit: z.number().int().min(1).max(200).optional() },
  async (args: { sessionId: string; limit?: number }) => runTool(async () => JSON.stringify(await fetchJSON('GET', `/opencode/sessions/${encodeURIComponent(args.sessionId)}/messages?limit=${encodeURIComponent(String(args.limit || 20))}`), null, 2)))

server.tool('opencode_session_children', 'List child sessions for an OpenCode session.', { sessionId: z.string() },
  async (args: { sessionId: string }) => runTool(async () => JSON.stringify(await fetchJSON('GET', `/opencode/sessions/${encodeURIComponent(args.sessionId)}/children`), null, 2)))

server.tool('opencode_session_web_url', 'Return the OpenCode Web URL for a session, or fallback recovery link text when unavailable.', { sessionId: z.string() },
  async (args: { sessionId: string }) => runTool(async () => {
    const result = await fetchJSON('GET', `/opencode/sessions/${encodeURIComponent(args.sessionId)}`)
    return formatOpenCodeSessionWebUrlToolResult(result)
  }))

server.tool('opencode_session_abort', 'Abort an OpenCode session.', { sessionId: z.string() },
  async (args: { sessionId: string }) => runTool(async () => JSON.stringify(await fetchJSON('POST', `/opencode/sessions/${encodeURIComponent(args.sessionId)}/abort`), null, 2)))

server.tool('profile_list', 'List Gateway scheduler profiles.', {},
  async () => runTool(async () => JSON.stringify(await fetchJSON('GET', '/profiles'), null, 2)))

server.tool('agent_catalog_list', 'List the Agent Factory catalog of profiles, teams, and persisted blueprint files.', {},
  async () => runTool(async () => JSON.stringify(await fetchJSON('GET', '/agent-factory/catalog'), null, 2)))

server.tool('team_assemble', 'Assemble a deterministic bounded team from a named Agent Factory blueprint/team definition without dispatching sessions. Returns stable team/member IDs, selected profile versions, least-privilege grants, budget/gate placeholders, and a durable audit receipt.', teamAssemblySchema,
  async (args: any) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/agent-factory/teams/assemble', args), null, 2)))

server.tool('team_assignment_create', 'Create deterministic executable team assignments for assembled team members with linked work/session IDs, budgets, scoped tools/skills, required evidence, gates, and a durable assignment receipt.', teamAssignmentCreateSchema,
  async (args: any) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/team-assignments', args), null, 2)))

server.tool('team_assignment_list', 'List durable team task assignments and their gate/review/completion receipts.', teamAssignmentListSchema,
  async (args: any) => runTool(async () => {
    const query = queryFromArgs(args)
    return JSON.stringify(await fetchJSON('GET', `/team-assignments${query ? `?${query}` : ''}`), null, 2)
  }))

server.tool('team_assignment_get', 'Get one durable team task assignment with receipt history.', { assignmentId: z.string() },
  async (args: { assignmentId: string }) => runTool(async () => JSON.stringify(await fetchJSON('GET', `/team-assignments/${encodeURIComponent(args.assignmentId)}`), null, 2)))

server.tool('team_assignment_receipt_record', 'Record a durable gate result, review outcome, or completion receipt for a team assignment.', teamAssignmentReceiptSchema,
  async (args: any) => runTool(async () => {
    const { assignmentId, ...body } = args
    return JSON.stringify(await fetchJSON('POST', `/team-assignments/${encodeURIComponent(assignmentId)}/receipts`, body), null, 2)
  }))

server.tool('profile_inspect', 'Inspect effective access, permissions, skills, tools, MCP servers, environment grants, and least-privilege warnings for one Gateway profile.', { name: z.string() },
  async (args: { name: string }) => runTool(async () => JSON.stringify(await fetchJSON('GET', `/profiles/${encodeURIComponent(args.name)}/inspection`), null, 2)))

server.tool('profile_upsert', 'Create or update a Gateway scheduler profile.', {
  name: z.string(),
  model: z.object({ providerID: z.string(), modelID: z.string(), variant: z.string().optional() }),
  agent: z.string(),
  skills: z.array(z.string()).optional(),
  permission: zStringRecord(z.string()).optional(),
  heartbeatMs: z.number().optional(),
  maxTokens: z.number().optional(),
  role: z.enum(['planning', 'execution']).optional(),
}, async (args: any) => runTool(async () => {
  const { name, ...profile } = args
  return JSON.stringify(await fetchJSON('PUT', `/profiles/${encodeURIComponent(name)}`, profile), null, 2)
}))

server.tool('profile_delete', 'Delete a Gateway scheduler profile.', { name: z.string() },
  async (args: { name: string }) => runTool(async () => JSON.stringify(await fetchJSON('DELETE', `/profiles/${encodeURIComponent(args.name)}`), null, 2)))

server.tool('agent_team_list', 'List Gateway project-scoped agent teams.', {},
  async () => runTool(async () => JSON.stringify(await fetchJSON('GET', '/agent-teams'), null, 2)))

server.tool('agent_team_get', 'Get one Gateway agent team and its current references.', { name: z.string() },
  async (args: { name: string }) => runTool(async () => JSON.stringify(await fetchJSON('GET', `/agent-teams/${encodeURIComponent(args.name)}`), null, 2)))

server.tool('agent_team_inspect', 'Inspect effective access, role/profile grants, capability requirements, and least-privilege warnings for one Gateway agent team.', { name: z.string() },
  async (args: { name: string }) => runTool(async () => JSON.stringify(await fetchJSON('GET', `/agent-teams/${encodeURIComponent(args.name)}/inspection`), null, 2)))

server.tool('agent_team_validate', 'Validate an agent team proposal without mutating Gateway config.', { name: z.string(), team: agentTeamSchema, taskId: z.string().optional(), stage: z.string().optional() },
  async (args: any) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/agent-teams/validate', args), null, 2)))

server.tool('agent_team_propose', 'Propose an agent team and open a human gate for applying it.', { name: z.string(), team: agentTeamSchema },
  async (args: any) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/agent-teams/propose', args), null, 2)))

server.tool('agent_team_apply', 'Apply an agent team after an approved human gate. Call without gateId to create the gate.', { name: z.string(), team: agentTeamSchema, gateId: z.string().optional(), approvedGateId: z.string().optional() },
  async (args: any) => runTool(async () => {
    const { name, ...body } = args
    return JSON.stringify(await fetchJSON('POST', `/agent-teams/${encodeURIComponent(name)}/apply`, body), null, 2)
  }))

server.tool('agent_team_delete', 'Delete an unreferenced agent team after an approved human gate. Call without gateId to create the gate.', { name: z.string(), gateId: z.string().optional(), approvedGateId: z.string().optional() },
  async (args: any) => runTool(async () => {
    const { name, ...body } = args
    return JSON.stringify(await fetchJSON('DELETE', `/agent-teams/${encodeURIComponent(name)}`, body), null, 2)
  }))

server.tool('agent_team_bind', 'Bind an agent team to exactly one roadmap or task after an approved human gate. Call without gateId to create the gate.', { name: z.string(), roadmapId: z.string().optional(), taskId: z.string().optional(), gateId: z.string().optional(), approvedGateId: z.string().optional() },
  async (args: any) => runTool(async () => {
    const { name, ...body } = args
    return JSON.stringify(await fetchJSON('POST', `/agent-teams/${encodeURIComponent(name)}/bind`, body), null, 2)
  }))

server.tool('promotion_scorecard_list', 'List scorecards for Gateway profiles or teams.', { subjectKind: z.enum(['profile', 'team']).optional(), subjectName: z.string().optional(), status: z.enum(['draft', 'evaluated', 'promoted', 'deprecated', 'blocked']).optional() },
  async (args: any) => runTool(async () => {
    const params = queryFromArgs(args)
    return JSON.stringify(await fetchJSON('GET', `/promotion/scorecards${params ? `?${params}` : ''}`), null, 2)
  }))

server.tool('promotion_scorecard_create', 'Create or update a deterministic profile/team scorecard from structured eval evidence.', {
  ...promotionSubjectSchema,
  subjectRevision: z.string().optional(),
  sourceKind: z.enum(['arena', 'eval', 'manual']).optional(),
  sourceId: z.string(),
  sourceVersion: z.string().optional(),
  metrics: z.array(zStringRecord(z.any())).optional(),
  thresholds: z.array(zStringRecord(z.any())).optional(),
  evidence: z.array(z.string()).optional(),
  conclusion: z.string().optional(),
  recommendation: z.enum(['promote', 'hold', 'block', 'deprecate']).optional(),
  status: z.enum(['draft', 'evaluated', 'promoted', 'deprecated', 'blocked']).optional(),
}, async (args: any) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/promotion/scorecards', args), null, 2)))

server.tool('promotion_state', 'Show current promotion state and decision history for a profile or team.', promotionSubjectSchema,
  async (args: any) => runTool(async () => {
    const params = queryFromArgs(args)
    return JSON.stringify(await fetchJSON('GET', `/promotion/state?${params}`), null, 2)
  }))

server.tool('promotion_decide', 'Promote, deprecate, block, or roll back a profile/team after an approved human gate. Rollback restores the latest eligible promoted baseline state. Call without gateId to create the gate.', {
  ...promotionSubjectOptionalSchema,
  action: z.enum(['promote', 'deprecate', 'rollback', 'block']).optional(),
  scorecardId: z.string().optional(),
  gateId: z.string().optional(),
  decisionId: z.string().optional(),
  note: z.string().optional(),
}, async (args: any) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/promotion/decisions', { ...args, actor: 'mcp', source: 'mcp' }), null, 2)))

server.tool('blueprint_preview', 'Validate a Gateway blueprint and return structured diff/preview without mutating config or OpenCode assets.', { blueprint: blueprintSchema },
  async (args: any) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/blueprints/preview', { blueprint: args.blueprint }), null, 2)))

server.tool('blueprint_catalog_list', 'List persisted Agent Factory blueprint files with validation, diff summary, and source metadata.', {},
  async () => runTool(async () => JSON.stringify(await fetchJSON('GET', '/blueprints'), null, 2)))

server.tool('blueprint_preview_text', 'Validate a Gateway blueprint and return a readable diff/preview without mutating config or OpenCode assets.', { blueprint: blueprintSchema },
  async (args: any) => runTool(async () => {
    const result = await fetchJSON('POST', '/blueprints/preview', { blueprint: args.blueprint })
    const { formatBlueprintPreview } = await import('./blueprints.js')
    return formatBlueprintPreview(result.preview)
  }))

server.tool('blueprint_apply', 'Apply a valid Gateway blueprint after an approved human gate. Call without gateId to create the gate; OpenCode assets remain referenced/proposed only.', { blueprint: blueprintSchema, gateId: z.string().optional(), approvedGateId: z.string().optional() },
  async (args: any) => runTool(async () => {
    const { blueprint, gateId, approvedGateId } = args
    return JSON.stringify(await fetchJSON('POST', '/blueprints/apply', { blueprint, gateId, approvedGateId }), null, 2)
  }))

server.tool('opencode_mcp_list', 'List OpenCode MCP server configuration in the selected config directory.', { configDir: z.string().optional() },
  async (args: { configDir?: string }) => runTool(async () => JSON.stringify(await fetchJSON('GET', `/opencode/mcp${args.configDir ? `?configDir=${encodeURIComponent(args.configDir)}` : ''}`), null, 2)))

server.tool('opencode_mcp_upsert', 'Create or update an OpenCode MCP server config entry.', {
  name: z.string(),
  server: zStringRecord(z.any()),
  configDir: z.string().optional(),
}, async (args: { name: string; server: Record<string, unknown>; configDir?: string }) => runTool(async () => {
  const { name, ...body } = args
  return JSON.stringify(await fetchJSON('PUT', `/opencode/mcp/${encodeURIComponent(name)}`, body), null, 2)
}))

server.tool('opencode_mcp_delete', 'Delete an OpenCode MCP server config entry.', { name: z.string(), configDir: z.string().optional() },
  async (args: { name: string; configDir?: string }) => runTool(async () => JSON.stringify(await fetchJSON('DELETE', `/opencode/mcp/${encodeURIComponent(args.name)}${args.configDir ? `?configDir=${encodeURIComponent(args.configDir)}` : ''}`), null, 2)))

server.tool('opencode_tool_list', 'List OpenCode custom tool files in the selected config directory.', { configDir: z.string().optional() },
  async (args: { configDir?: string }) => runTool(async () => JSON.stringify(await fetchJSON('GET', `/opencode/tools${args.configDir ? `?configDir=${encodeURIComponent(args.configDir)}` : ''}`), null, 2)))

server.tool('opencode_tool_upsert', 'Create or update an OpenCode custom tool file.', { name: z.string(), content: z.string(), extension: z.enum(['ts', 'js']).optional(), configDir: z.string().optional() },
  async (args: { name: string; content: string; extension?: 'ts' | 'js'; configDir?: string }) => runTool(async () => {
    const { name, ...body } = args
    return JSON.stringify(await fetchJSON('PUT', `/opencode/tools/${encodeURIComponent(name)}`, body), null, 2)
  }))

server.tool('session_admit', 'Admit a capacity-gated OpenCode session (no free spawn). Returns sessionId + admission receipt.', {
  title: z.string().optional(),
  agent: z.string().optional(),
  directory: z.string().optional(),
  presenceId: z.string().optional(),
  taskId: z.string().optional(),
  purpose: z.enum(['interactive', 'worker', 'presence']).optional(),
}, async (args: any) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/sessions/admit', args), null, 2)))

server.tool('persona_list', 'List OpenCode agents available as personas (mode/primary-aware labels).', { configDir: z.string().optional() },
  async (args: { configDir?: string }) => runTool(async () => JSON.stringify(await fetchJSON('GET', `/personas${args.configDir ? `?configDir=${encodeURIComponent(args.configDir)}` : ''}`), null, 2)))

server.tool('persona_create', 'Create an OpenCode primary-mode agent persona (and optional skill).', {
  name: z.string(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  skillContent: z.string().optional(),
  configDir: z.string().optional(),
}, async (args: any) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/personas', args), null, 2)))

server.tool('agent_presence_list', 'List durable AgentPresence records (always-on assistant bindings; not channel typing presence).', {
  status: z.string().optional(),
  includeArchived: z.boolean().optional(),
}, async (args: { status?: string; includeArchived?: boolean }) => runTool(async () => {
  const params = new URLSearchParams()
  if (args.status) params.set('status', args.status)
  if (args.includeArchived) params.set('includeArchived', 'true')
  const q = params.toString()
  return JSON.stringify(await fetchJSON('GET', `/agent-presences${q ? `?${q}` : ''}`), null, 2)
}))

server.tool('agent_presence_get', 'Get one AgentPresence by id.', { presenceId: z.string() },
  async (args: { presenceId: string }) => runTool(async () => JSON.stringify(await fetchJSON('GET', `/agent-presences/${encodeURIComponent(args.presenceId)}`), null, 2)))

server.tool('agent_presence_create', 'Create a durable AgentPresence for an OpenCode agent (sticky always-on session binding).', {
  name: z.string(),
  opencodeAgent: z.string(),
  sessionId: z.string().optional(),
  directory: z.string().optional(),
  profile: z.string().optional(),
  provider: z.string().optional(),
  chatId: z.string().optional(),
  threadId: z.string().optional(),
  note: z.string().optional(),
}, async (args: any) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/agent-presences', args), null, 2)))

server.tool('agent_presence_update', 'Update an AgentPresence (status, channel bind, sticky session id).', {
  presenceId: z.string(),
  name: z.string().optional(),
  opencodeAgent: z.string().optional(),
  sessionId: z.string().nullable().optional(),
  status: z.enum(['active', 'paused', 'blocked', 'archived']).optional(),
  provider: z.string().nullable().optional(),
  chatId: z.string().nullable().optional(),
  threadId: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
}, async (args: any) => runTool(async () => {
  const { presenceId, ...body } = args
  return JSON.stringify(await fetchJSON('PATCH', `/agent-presences/${encodeURIComponent(presenceId)}`, body), null, 2)
}))

server.tool('opencode_tool_delete', 'Delete an OpenCode custom tool file.', { name: z.string(), configDir: z.string().optional() },
  async (args: { name: string; configDir?: string }) => runTool(async () => JSON.stringify(await fetchJSON('DELETE', `/opencode/tools/${encodeURIComponent(args.name)}${args.configDir ? `?configDir=${encodeURIComponent(args.configDir)}` : ''}`), null, 2)))

server.tool('opencode_agent_list', 'List OpenCode-native agents in the selected OpenCode config directory.', { configDir: z.string().optional() },
  async (args: { configDir?: string }) => runTool(async () => JSON.stringify(await fetchJSON('GET', `/opencode/agents${args.configDir ? `?configDir=${encodeURIComponent(args.configDir)}` : ''}`), null, 2)))

server.tool('opencode_agent_upsert', 'Create or update an OpenCode-native agent in opencode.jsonc.', {
  name: z.string(),
  model: z.string().optional(),
  variant: z.string().optional(),
  prompt: z.string().optional(),
  description: z.string().optional(),
  mode: z.enum(['subagent', 'primary', 'all']).optional(),
  temperature: z.number().optional(),
  maxSteps: z.number().optional(),
  hidden: z.boolean().optional(),
  disable: z.boolean().optional(),
  tools: zStringRecord(z.boolean()).optional(),
  permission: zStringRecord(z.any()).optional(),
  configDir: z.string().optional(),
}, async (args: any) => runTool(async () => {
  const { name, ...body } = args
  return JSON.stringify(await fetchJSON('PUT', `/opencode/agents/${encodeURIComponent(name)}`, body), null, 2)
}))

server.tool('opencode_agent_delete', 'Delete an OpenCode-native agent from opencode.jsonc.', { name: z.string(), configDir: z.string().optional() },
  async (args: { name: string; configDir?: string }) => runTool(async () => JSON.stringify(await fetchJSON('DELETE', `/opencode/agents/${encodeURIComponent(args.name)}${args.configDir ? `?configDir=${encodeURIComponent(args.configDir)}` : ''}`), null, 2)))

server.tool('opencode_skill_list', 'List OpenCode skills in the selected OpenCode config directory.', { configDir: z.string().optional() },
  async (args: { configDir?: string }) => runTool(async () => JSON.stringify(await fetchJSON('GET', `/opencode/skills${args.configDir ? `?configDir=${encodeURIComponent(args.configDir)}` : ''}`), null, 2)))

server.tool('opencode_skill_upsert', 'Create or update an OpenCode skill SKILL.md file.', { name: z.string(), content: z.string(), configDir: z.string().optional() },
  async (args: { name: string; content: string; configDir?: string }) => runTool(async () => {
    const { name, ...body } = args
    return JSON.stringify(await fetchJSON('PUT', `/opencode/skills/${encodeURIComponent(name)}`, body), null, 2)
  }))

server.tool('opencode_skill_delete', 'Delete an OpenCode skill directory.', { name: z.string(), configDir: z.string().optional() },
  async (args: { name: string; configDir?: string }) => runTool(async () => JSON.stringify(await fetchJSON('DELETE', `/opencode/skills/${encodeURIComponent(args.name)}${args.configDir ? `?configDir=${encodeURIComponent(args.configDir)}` : ''}`), null, 2)))

export function formatOpenCodeSessionWebUrlToolResult(result: { webUrl?: string | null; linksText?: string | null } | null | undefined): string {
  return result?.webUrl || result?.linksText || 'OpenCode Web URL unavailable.'
}

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[gateway-proxy] Connected to daemon at', DAEMON_URL)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error('[gateway-proxy] Fatal:', err); process.exit(1) })
}

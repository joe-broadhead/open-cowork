import { randomBytes } from 'node:crypto'
import type {
  WorkflowDraft,
  WorkflowToolCreateRequest,
  WorkflowToolCreateResult,
  WorkflowToolPreview,
} from '@open-cowork/shared'
import {
  createWorkflow,
  previewWorkflowDraft,
  type WorkflowCapabilityValidationContext,
} from './workflow-store.ts'
import { getWorkflowWebhookBaseUrl } from './workflow-webhook-server.ts'
import {
  getConfiguredAgentsFromConfig,
  getConfiguredSkillsFromConfig,
  getConfiguredToolsFromConfig,
} from '../config-loader.ts'
import { getBuiltInAgentOverride } from '../built-in-agent-overrides.ts'
import { getRuntimeCatalogSnapshot } from '../runtime-catalog-snapshot.ts'
import { log } from '../logger.ts'

let publishWorkflowUpdated: (() => void) | null = null
const PREVIEW_TOKEN_TTL_MS = 30 * 60 * 1000
const PREVIEW_TOKEN_MAX_ENTRIES = 256
const BUILT_IN_AGENT_NAMES = ['build', 'plan', 'general', 'explore', 'chief-of-staff', 'executive-assistant', 'autoresearch'] as const
const previewTokens = new Map<string, { normalizedDraft: WorkflowDraft; expiresAt: number }>()

export class WorkflowToolActionError extends Error {}

export function configureWorkflowToolActions(options: { publishWorkflowUpdated: () => void }) {
  publishWorkflowUpdated = options.publishWorkflowUpdated
}

function cloneWorkflowDraft(draft: WorkflowDraft): WorkflowDraft {
  return JSON.parse(JSON.stringify(draft)) as WorkflowDraft
}

function pruneExpiredPreviewTokens(now = Date.now()) {
  for (const [token, preview] of previewTokens.entries()) {
    if (preview.expiresAt <= now) previewTokens.delete(token)
  }
}

function mintPreviewToken(normalizedDraft: WorkflowDraft) {
  pruneExpiredPreviewTokens()
  while (previewTokens.size >= PREVIEW_TOKEN_MAX_ENTRIES) {
    const oldest = previewTokens.keys().next().value
    if (typeof oldest !== 'string') break
    previewTokens.delete(oldest)
  }
  const token = randomBytes(32).toString('base64url')
  previewTokens.set(token, {
    normalizedDraft: cloneWorkflowDraft(normalizedDraft),
    expiresAt: Date.now() + PREVIEW_TOKEN_TTL_MS,
  })
  return token
}

function readPreviewToken(request: WorkflowToolCreateRequest) {
  const record = request && typeof request === 'object' && !Array.isArray(request)
    ? request as Partial<WorkflowToolCreateRequest>
    : null
  const previewToken = typeof record?.previewToken === 'string' ? record.previewToken.trim() : ''
  if (!previewToken) {
    throw new WorkflowToolActionError('Workflow create requires the previewToken returned by preview_workflow after the user confirms the preview.')
  }
  return previewToken
}

function sorted(values: Set<string>) {
  return Array.from(values).filter(Boolean).sort((a, b) => a.localeCompare(b))
}

async function resolveWorkflowCapabilityContext(draft: WorkflowDraft): Promise<WorkflowCapabilityValidationContext> {
  const agentNames = new Set<string>()
  const fallbackSkillNames = getConfiguredSkillsFromConfig().map((skill) => skill.sourceName)
  const skillNames = new Set<string>()
  const toolIds = new Set(getConfiguredToolsFromConfig().map((tool) => tool.id))

  for (const agentName of BUILT_IN_AGENT_NAMES) {
    if (getBuiltInAgentOverride(agentName)?.disable === true) continue
    agentNames.add(agentName)
  }
  for (const agent of getConfiguredAgentsFromConfig()) agentNames.add(agent.name)

  try {
    const projectDirectory = typeof draft.projectDirectory === 'string' && draft.projectDirectory.trim()
      ? draft.projectDirectory
      : undefined
    const snapshot = await getRuntimeCatalogSnapshot(projectDirectory ? { directory: projectDirectory } : undefined)
    for (const skill of snapshot.availableSkills) skillNames.add(skill.name)
    for (const tool of snapshot.builtinTools) toolIds.add(tool.id)
    for (const mcp of snapshot.customMcps) {
      if (mcp.name) toolIds.add(mcp.name)
    }
    for (const tool of snapshot.runtimeTools) toolIds.add(tool.id)
    for (const agent of snapshot.customAgentSummaries) {
      if (agent.enabled && agent.valid) agentNames.add(agent.name)
    }
  } catch (error) {
    for (const skillName of fallbackSkillNames) skillNames.add(skillName)
    log('error', `Workflow capability validation catalog lookup failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  return {
    agentNames: sorted(agentNames),
    skillNames: sorted(skillNames),
    toolIds: sorted(toolIds),
  }
}

export async function previewWorkflowFromTool(draft: WorkflowDraft): Promise<WorkflowToolPreview> {
  const capabilities = await resolveWorkflowCapabilityContext(draft)
  const preview = previewWorkflowDraft(draft, { capabilities })
  if (!preview.ok || !preview.normalizedDraft) return preview
  return {
    ...preview,
    previewToken: mintPreviewToken(preview.normalizedDraft),
  }
}

export async function createWorkflowFromTool(request: WorkflowToolCreateRequest): Promise<WorkflowToolCreateResult> {
  const previewToken = readPreviewToken(request)
  pruneExpiredPreviewTokens()
  const preview = previewTokens.get(previewToken)
  previewTokens.delete(previewToken)
  if (!preview) {
    throw new WorkflowToolActionError('Workflow create requires a valid confirmed preview token. Preview the workflow, ask the user to confirm it, then pass previewToken to create_workflow.')
  }

  try {
    const normalizedDraft = cloneWorkflowDraft(preview.normalizedDraft)
    const capabilities = await resolveWorkflowCapabilityContext(normalizedDraft)
    const workflow = createWorkflow(normalizedDraft, getWorkflowWebhookBaseUrl(), { capabilities })
    publishWorkflowUpdated?.()
    return { ok: true, workflow }
  } catch (error) {
    throw new WorkflowToolActionError(error instanceof Error ? error.message : 'Workflow create failed.')
  }
}

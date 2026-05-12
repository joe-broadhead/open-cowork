import type { GovernanceRevokedTool, GovernanceToolIncidentControlRequest } from '@open-cowork/shared'
import { recordGovernanceAuditEvent } from './governance-audit-store.ts'
import { saveRevokedGovernanceTool } from './governance-tool-policy-store.ts'
import { resolveGovernanceToolControlTarget } from './governance-tool-policy.ts'

const MAX_INCIDENT_REASON_BYTES = 16 * 1024
const MAX_TOOL_ID_BYTES = 512

export type GovernanceToolIncidentControlDependencies = {
  rebootRuntime: () => Promise<void>
}

function boundedToolId(value: unknown) {
  if (typeof value !== 'string') throw new Error('Tool incident id must be a string.')
  const toolId = value.trim()
  if (!toolId) throw new Error('Tool incident id is required.')
  if (Buffer.byteLength(toolId, 'utf8') > MAX_TOOL_ID_BYTES) throw new Error('Tool incident id is too large.')
  return toolId
}

function boundedReason(value: unknown, fallback: string) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new Error('Tool incident reason must be a string.')
  const reason = value.trim()
  if (!reason) return fallback
  if (Buffer.byteLength(reason, 'utf8') > MAX_INCIDENT_REASON_BYTES) {
    throw new Error('Tool incident reason is too large.')
  }
  return reason
}

export async function revokeGovernanceTool(
  request: GovernanceToolIncidentControlRequest,
  dependencies: GovernanceToolIncidentControlDependencies,
): Promise<GovernanceRevokedTool> {
  const toolId = boundedToolId(request.toolId)
  const target = resolveGovernanceToolControlTarget(toolId, request.context)
  if (!target) throw new Error(`No tool found for governance incident ${toolId}.`)

  const reason = boundedReason(request.reason, 'Tool revoked through governance incident control.')
  const revoked = saveRevokedGovernanceTool({
    toolId: target.toolId,
    label: target.label,
    patterns: target.patterns,
    source: target.source,
    scope: target.scope,
    directory: target.directory,
    reason,
    revokedBy: 'local-user',
  })
  recordGovernanceAuditEvent({
    subjectKind: 'tool',
    subjectId: `tool:${encodeURIComponent(target.toolId)}`,
    action: 'revoke_tool',
    beforeLifecycle: 'active',
    afterLifecycle: 'revoked',
    reason,
    metadata: {
      toolId: target.toolId,
      label: target.label,
      patterns: target.patterns,
      source: target.source,
      scope: target.scope,
      directory: target.directory,
    },
  })
  await dependencies.rebootRuntime()
  return revoked
}

import type { KnowledgeSpace } from '@open-cowork/shared'
import { knowledgeRoleCanPropose } from '@open-cowork/shared'
import { asRecord } from './react-workbench-controller.ts'

function text(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

export function cloudKnowledgeAuthorityRole(bootstrapRole: unknown, workspace: unknown) {
  const workspaceRecord = asRecord(workspace)
  const principal = asRecord(workspaceRecord.principal)
  const member = asRecord(workspaceRecord.member)
  return text(workspaceRecord.role, text(principal.role, text(member.role, text(bootstrapRole))))
}

export function canManageCloudKnowledge(bootstrapRole: unknown, workspace: unknown) {
  const role = cloudKnowledgeAuthorityRole(bootstrapRole, workspace).toLowerCase()
  return role === 'owner' || role === 'admin'
}

export function knowledgeCaptureSpace(spaces: KnowledgeSpace[]) {
  return spaces.find((candidate) => knowledgeRoleCanPropose(candidate.role)) || null
}

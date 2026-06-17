import type { KnowledgeSpace, KnowledgeSpaceVisibility } from '@open-cowork/shared'
import { KNOWLEDGE_VISIBILITIES, knowledgeRoleCanPropose, knowledgeVisibilityLabel } from '@open-cowork/shared'
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

/** The default visibility a new Space is created with (matches the Knowledge store server default). */
export const KNOWLEDGE_DEFAULT_VISIBILITY: KnowledgeSpaceVisibility = 'team'

/** Visibility choices for the "New Space" form, labelled via the single-sourced shared helper. */
export const KNOWLEDGE_VISIBILITY_OPTIONS = KNOWLEDGE_VISIBILITIES.map((value) => ({
  value,
  label: knowledgeVisibilityLabel(value),
}))

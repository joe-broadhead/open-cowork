import { createHash } from 'node:crypto'

export class InvalidWorkflowPageCursorError extends Error {
  constructor(message = 'Workflow list cursor is invalid.') {
    super(message)
    this.name = 'InvalidWorkflowPageCursorError'
  }
}

export type WorkflowPageCursorScope = {
  tenantId: string
  userId: string
}

function workflowPageCursorScopeHash(scope: WorkflowPageCursorScope) {
  return createHash('sha256')
    .update(JSON.stringify({ tenantId: scope.tenantId, userId: scope.userId }))
    .digest('base64url')
}

export function encodeWorkflowPageCursor(
  workflow: { updatedAt: string, id: string },
  scope?: WorkflowPageCursorScope,
) {
  const payload: Record<string, unknown> = {
    v: 1,
    updatedAt: workflow.updatedAt,
    workflowId: workflow.id,
  }
  if (scope) payload.scopeHash = workflowPageCursorScopeHash(scope)
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeWorkflowPageCursor(
  cursor: string | null | undefined,
  expectedScope?: WorkflowPageCursorScope,
): { updatedAt: string, workflowId: string } | null {
  if (!cursor) return null
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (
      parsed
      && typeof parsed === 'object'
      && typeof parsed.updatedAt === 'string'
      && typeof parsed.workflowId === 'string'
    ) {
      if (expectedScope) {
        const expectedHash = workflowPageCursorScopeHash(expectedScope)
        if (typeof parsed.scopeHash !== 'string' || parsed.scopeHash !== expectedHash) {
          throw new InvalidWorkflowPageCursorError('Workflow list cursor does not match the requested scope.')
        }
      }
      return { updatedAt: parsed.updatedAt, workflowId: parsed.workflowId }
    }
  } catch (error) {
    if (error instanceof InvalidWorkflowPageCursorError) throw error
    throw new InvalidWorkflowPageCursorError()
  }
  throw new InvalidWorkflowPageCursorError()
}

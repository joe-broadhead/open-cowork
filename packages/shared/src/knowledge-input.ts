import type { KnowledgeProposalInput } from './knowledge.js'

// Shared coercion of the request body for knowledge proposal content, used by
// BOTH the desktop IPC handlers and the Cloud HTTP route so the two trust
// boundaries normalize identically rather than diverging. The knowledge store
// re-validates everything regardless; this keeps the two front doors consistent
// (and the cloud path from spreading a raw, un-coerced body).
//
// Workspace and actor (`by`) are intentionally NOT set here — each caller injects
// those from its own authenticated context after normalizing. (Review input
// carries no content beyond workspace + reviewer, so it needs no normalizer.)

export function normalizeKnowledgeProposalContent(
  value: Record<string, unknown>,
): Omit<KnowledgeProposalInput, 'workspaceId' | 'by'> {
  const pageId = typeof value.pageId === 'string' && value.pageId.trim()
    ? value.pageId.trim()
    : value.pageId === null ? null : undefined
  const add = typeof value.add === 'number' ? value.add : value.add === null ? null : undefined
  const del = typeof value.del === 'number' ? value.del : value.del === null ? null : undefined

  return {
    spaceId: value.spaceId as KnowledgeProposalInput['spaceId'],
    ...(pageId !== undefined ? { pageId } : {}),
    pageTitle: value.pageTitle as KnowledgeProposalInput['pageTitle'],
    summary: value.summary as KnowledgeProposalInput['summary'],
    ...(add !== undefined ? { add } : {}),
    ...(del !== undefined ? { del } : {}),
    ...(Array.isArray(value.links) ? { links: value.links as KnowledgeProposalInput['links'] } : {}),
    body: value.body as KnowledgeProposalInput['body'],
  }
}

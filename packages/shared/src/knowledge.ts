import type { WorkspaceOptions } from './workspace.js'

export const KNOWLEDGE_VISIBILITIES = ['company', 'team', 'private'] as const
export type KnowledgeSpaceVisibility = typeof KNOWLEDGE_VISIBILITIES[number]

export const KNOWLEDGE_SPACE_ROLES = ['Reader', 'Contributor', 'Maintainer'] as const
export type KnowledgeSpaceRole = typeof KNOWLEDGE_SPACE_ROLES[number]

export const KNOWLEDGE_LINK_KINDS = ['thread', 'task', 'artifact'] as const
export type KnowledgeLinkKind = typeof KNOWLEDGE_LINK_KINDS[number]

export const KNOWLEDGE_PROPOSAL_STATUSES = ['pending', 'accepted', 'declined'] as const
export type KnowledgeProposalStatus = typeof KNOWLEDGE_PROPOSAL_STATUSES[number]

export type KnowledgeSpace = {
  id: string
  name: string
  icon?: string | null
  hue?: string | null
  visibility: KnowledgeSpaceVisibility
  role: KnowledgeSpaceRole
}

export type KnowledgePageLink = {
  kind: KnowledgeLinkKind
  label: string
  targetId?: string | null
}

export type KnowledgePageBlock =
  | { id?: string; type: 'callout'; text: string }
  | { id?: string; type: 'h'; text: string }
  | { id?: string; type: 'p'; text: string }
  | { id?: string; type: 'list'; items: string[] }

export type KnowledgePage = {
  id: string
  spaceId: string
  title: string
  updatedBy: string
  updatedAt: string
  version: number
  revision: string
  links: KnowledgePageLink[]
  body: KnowledgePageBlock[]
}

export type KnowledgePageVersion = KnowledgePage & {
  versionId: string
  pageId: string
  proposalId?: string | null
}

export type KnowledgeProposal = {
  id: string
  pageId?: string | null
  pageTitle: string
  spaceId: string
  by: string
  when: string
  summary: string
  add: number
  del: number
  status: KnowledgeProposalStatus
  reviewedAt?: string | null
  reviewedBy?: string | null
  links: KnowledgePageLink[]
  body: KnowledgePageBlock[]
}

export type KnowledgeGraphNode = {
  id: string
  kind: 'root' | 'space' | 'page'
  label: string
  spaceId?: string | null
}

export type KnowledgeGraphEdge = {
  id: string
  source: string
  target: string
  kind: 'contains' | 'links'
}

export type KnowledgeGraph = {
  nodes: KnowledgeGraphNode[]
  edges: KnowledgeGraphEdge[]
}

export type KnowledgeGraphLayoutNode = {
  id: string
  kind: 'root' | 'space' | 'page'
  label: string
  x: number
  y: number
  r: number
  /** Index of the owning space (for hue selection); -1 for the root. */
  spaceIndex: number
  /** The page id to open when clicked, or null for root/space nodes. */
  pageId: string | null
}

export type KnowledgeGraphLayout = {
  width: number
  height: number
  nodes: KnowledgeGraphLayoutNode[]
  edges: KnowledgeGraphEdge[]
  spaceCount: number
}

/**
 * Compute a clustered radial layout for the knowledge graph: a central root, the
 * Spaces orbiting the root, and each Space's pages fanned around their Space.
 * Pure and deterministic so both surfaces (desktop + Cloud Web) render an
 * identical graph and the layout can be unit-tested without a DOM.
 */
export function computeKnowledgeGraphLayout(graph: KnowledgeGraph): KnowledgeGraphLayout {
  const width = 1000
  const height = 700
  const cx = width / 2
  const cy = height / 2
  const spaces = graph.nodes.filter((node) => node.kind === 'space')
  const nodes: KnowledgeGraphLayoutNode[] = []
  const placed = new Set<string>()

  const root = graph.nodes.find((node) => node.kind === 'root')
  if (root) {
    nodes.push({ id: root.id, kind: 'root', label: root.label, x: cx, y: cy, r: 22, spaceIndex: -1, pageId: null })
    placed.add(root.id)
  }

  const spaceRingRadius = spaces.length > 0 ? 210 : 0
  spaces.forEach((space, spaceIndex) => {
    const spaceAngle = (Math.PI * 2 * spaceIndex) / Math.max(1, spaces.length) - Math.PI / 2
    const sx = cx + Math.cos(spaceAngle) * spaceRingRadius
    const sy = cy + Math.sin(spaceAngle) * spaceRingRadius
    nodes.push({ id: space.id, kind: 'space', label: space.label, x: sx, y: sy, r: 14, spaceIndex, pageId: null })
    placed.add(space.id)

    const pages = graph.nodes.filter((node) => node.kind === 'page' && node.spaceId === space.id)
    const pageRingRadius = 96
    // Fan the pages in an arc centred on the direction pointing away from the root,
    // so labels open outward instead of colliding with the centre.
    const arc = Math.PI * 1.5
    const step = pages.length > 1 ? arc / (pages.length - 1) : 0
    const start = spaceAngle - (step * (pages.length - 1)) / 2
    pages.forEach((page, pageIndex) => {
      const pageAngle = pages.length > 1 ? start + step * pageIndex : spaceAngle
      const px = sx + Math.cos(pageAngle) * pageRingRadius
      const py = sy + Math.sin(pageAngle) * (pageRingRadius * 0.9)
      nodes.push({ id: page.id, kind: 'page', label: page.label, x: px, y: py, r: 8, spaceIndex, pageId: page.id })
      placed.add(page.id)
    })
  })

  // Any node not attached to a known space (orphan pages, or pages on a missing
  // space) still gets placed, on an outer ring around the root, so nothing is lost.
  const orphans = graph.nodes.filter((node) => !placed.has(node.id))
  orphans.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(1, orphans.length) - Math.PI / 2
    nodes.push({
      id: node.id,
      kind: node.kind,
      label: node.label,
      x: cx + Math.cos(angle) * 310,
      y: cy + Math.sin(angle) * 300,
      r: node.kind === 'space' ? 14 : 8,
      spaceIndex: spaces.length + index,
      pageId: node.kind === 'page' ? node.id : null,
    })
  })

  return { width, height, nodes, edges: graph.edges, spaceCount: spaces.length }
}

export type KnowledgeSnapshotPayload = {
  spaces: KnowledgeSpace[]
  pages: KnowledgePage[]
  proposals: KnowledgeProposal[]
  graph: KnowledgeGraph
  limit?: number
  truncated?: boolean
}

export type KnowledgeSnapshotOptions = WorkspaceOptions & {
  spaceId?: string | null
  limit?: number | null
}

export type KnowledgeProposalInput = WorkspaceOptions & {
  spaceId: string
  pageId?: string | null
  pageTitle: string
  by?: string | null
  summary: string
  add?: number | null
  del?: number | null
  links?: KnowledgePageLink[]
  body: KnowledgePageBlock[]
}

export type KnowledgeReviewInput = WorkspaceOptions & {
  reviewedBy?: string | null
}

export type KnowledgeSpaceInput = WorkspaceOptions & {
  name: string
  visibility?: KnowledgeSpaceVisibility | null
  icon?: string | null
  hue?: string | null
}

export function isKnowledgeSpaceVisibility(value: unknown): value is KnowledgeSpaceVisibility {
  return typeof value === 'string' && (KNOWLEDGE_VISIBILITIES as readonly string[]).includes(value)
}

/**
 * Canonical, human-readable label for a Space's visibility. Single-sourced so the
 * desktop breadcrumb and the Cloud Web breadcrumb render identical text instead
 * of leaking the raw `'company'` token. Unknown/missing values default to the
 * broadest ("Company-wide") visibility.
 */
export function knowledgeVisibilityLabel(visibility: KnowledgeSpaceVisibility | string | null | undefined): string {
  if (visibility === 'team') return 'Team'
  if (visibility === 'private') return 'Private'
  return 'Company-wide'
}

export function isKnowledgeSpaceRole(value: unknown): value is KnowledgeSpaceRole {
  return typeof value === 'string' && (KNOWLEDGE_SPACE_ROLES as readonly string[]).includes(value)
}

export function isKnowledgeLinkKind(value: unknown): value is KnowledgeLinkKind {
  return typeof value === 'string' && (KNOWLEDGE_LINK_KINDS as readonly string[]).includes(value)
}

export function isKnowledgeProposalStatus(value: unknown): value is KnowledgeProposalStatus {
  return typeof value === 'string' && (KNOWLEDGE_PROPOSAL_STATUSES as readonly string[]).includes(value)
}

export function knowledgeRoleCanRead(role: KnowledgeSpaceRole) {
  return role === 'Reader' || role === 'Contributor' || role === 'Maintainer'
}

export function knowledgeRoleCanPropose(role: KnowledgeSpaceRole) {
  return role === 'Contributor' || role === 'Maintainer'
}

export function knowledgeRoleCanReview(role: KnowledgeSpaceRole) {
  return role === 'Maintainer'
}

/** An editable, flat representation of a page block for the "Propose edit" composer. */
export type KnowledgeBlockDraft = {
  id: string
  type: KnowledgePageBlock['type']
  text: string
}

/**
 * Flatten a page's typed blocks into editable text drafts (one textarea each):
 * heading/paragraph/callout keep their text; list items join on newlines.
 * Pure + reversible with `knowledgeDraftToBlocks` so the composer can round-trip
 * the page body without losing block structure.
 */
export function knowledgePageBlocksToDraft(blocks: KnowledgePageBlock[]): KnowledgeBlockDraft[] {
  return blocks.map((block, index) => ({
    id: block.id || `block-${index + 1}`,
    type: block.type,
    text: block.type === 'list' ? block.items.join('\n') : block.text,
  }))
}

/**
 * Rebuild typed page blocks from edited drafts, preserving each block's id + type.
 * List drafts split back into trimmed, non-empty items; empty blocks are dropped
 * so the result is a clean, non-empty body the Knowledge store will accept.
 */
export function knowledgeDraftToBlocks(drafts: KnowledgeBlockDraft[]): KnowledgePageBlock[] {
  const blocks: KnowledgePageBlock[] = []
  for (const draft of drafts) {
    const text = draft.text.replace(/\r\n/g, '\n')
    if (draft.type === 'list') {
      const items = text.split('\n').map((line) => line.trim()).filter(Boolean)
      if (items.length) blocks.push({ id: draft.id, type: 'list', items })
      continue
    }
    const trimmed = text.trim()
    if (!trimmed) continue
    if (draft.type === 'h') blocks.push({ id: draft.id, type: 'h', text: trimmed })
    else if (draft.type === 'callout') blocks.push({ id: draft.id, type: 'callout', text: trimmed })
    else blocks.push({ id: draft.id, type: 'p', text: trimmed })
  }
  return blocks
}

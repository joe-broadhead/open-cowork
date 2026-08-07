/**
 * OpenWiki browse/read surface types shared between the Electron main process
 * (which runs the local `openwiki` CLI) and the renderer Wiki surface.
 *
 * The wiki is the optional sibling "OpenWiki" product served from a local root
 * (default `~/Open Wiki`). This surface is read-oriented: list pages, read the
 * markdown body of a page, and search. Edits stay in the agent-facing MCP
 * (`proposal` mode); the browse UI is for viewing.
 */

export type WikiLinkStatus =
  | 'linked'
  | 'no-cli'
  | 'no-root'
  | 'unavailable'

/** Status of the local wiki plus the root it is served from. */
export interface WikiOverview {
  status: WikiLinkStatus
  root: string | null
  cli: string | null
  pageCount: number
  error: string | null
  /** Source this overview describes: local CLI or a connected remote wiki. */
  source: WikiSourceKind
  /** Remote origin when `source` is remote, otherwise null. */
  origin: string | null
}

/** Which wiki the browse surface reads from. */
export type WikiSourceKind = 'local' | 'remote'

/** A saved desktop connection to a hosted OpenWiki server (token held in main). */
export interface WikiRemoteConnectionSummary {
  id: string
  origin: string
  label: string
  authMethod: 'oauth' | 'token'
  status: 'connected' | 'unavailable'
  error: string | null
  workspace: string | null
  pageCount: number | null
  createdAt: string
  lastUsedAt: string | null
}

/** Current wiki source + saved connections (what the renderer needs to switch). */
export interface WikiSourceState {
  kind: WikiSourceKind
  connectionId: string | null
  connection: WikiRemoteConnectionSummary | null
  connections: WikiRemoteConnectionSummary[]
}

/** Request to start the OAuth (PKCE) connect flow for a hosted wiki origin. */
export interface WikiConnectRequest {
  origin: string
  label?: string
}

/** Request to save a scoped service-account bearer token for a hosted wiki. */
export interface WikiConnectTokenRequest {
  origin: string
  token: string
  label?: string
}

/** Result of a connect/remove/activate mutation: new source state + error. */
export interface WikiSourceResult extends WikiSourceState {
  ok: boolean
  error: string | null
}

/** A page in the sidebar catalog (from `openwiki pages list`). */
export interface WikiPageIndexEntry {
  id: string
  title: string
  path: string
  /** Section id (e.g. `section:hr-private`) or null when unclassified. */
  section: string | null
  sectionTitle: string | null
  /** True when the page path belongs to a private section. */
  isPrivate: boolean
  summary: string
  topics: string[]
  updatedAt: string | null
}

/** A full page fetched with `openwiki page read <id>`. */
export interface WikiDocument {
  id: string
  title: string
  path: string
  section: string | null
  sectionTitle: string | null
  isPrivate: boolean
  bodyMarkdown: string
  summary: string
  status: string
  updatedAt: string | null
}

/** A lightweight search hit (openwiki search / pages). */
export interface WikiSearchResult {
  id: string
  title: string
  path: string
  snippet: string
  isPrivate: boolean
}


/** Edge kinds materialized in the OpenWiki graph index (mirror @openwiki/core). */
export type WikiGraphEdgeType =
  | 'page_link'
  | 'page_typed_link'
  | 'page_source'
  | 'page_claim'
  | 'claim_source'
  | 'fact_subject'
  | 'fact_page'
  | 'fact_source'
  | 'fact_claim'
  | 'take_page'
  | 'take_source'
  | 'take_claim'
  | 'proposal_target'
  | 'decision_proposal'
  | 'page_topic'
  | 'page_section'
  | 'source_relation'

/** A node in the wiki graph index (page, source, claim, topic, proposal, ...). */
export interface WikiGraphNode {
  id: string
  /** Record type: page | source | claim | topic | proposal | decision | ... */
  recordType: string
  title: string
  path?: string | null
  status?: string | null
  summary?: string | null
}

/** A directed edge between two graph nodes. */
export interface WikiGraphEdge {
  fromId: string
  toId: string
  edgeType: WikiGraphEdgeType
  weight?: number
  path?: string | null
  anchor?: string | null
}

/** The whole-workspace graph index (or a client-side sub-selection). */
export interface WikiGraph {
  nodes: WikiGraphNode[]
  edges: WikiGraphEdge[]
}

/** A per-record neighborhood (self + neighbors within a depth). Used for backlinks/related. */
export interface WikiGraphNeighbors extends WikiGraph {
  rootId: string
  depth: number
  direction: 'in' | 'out' | 'both'
}

/** A wikilink `[[target]]` encountered in a page body and its resolution. */
export interface WikiWikilinkResolution {
  /** The raw target inside the wikilink (e.g. `My Page`, `page:page:x`, `path/to/page`). */
  target: string
  /** Resolved page id, or null when no page matched. */
  pageId: string | null
  /** Optional section/anchor after `#` inside the wikilink. */
  anchor: string | null
  /** Optional display alias after `|`. */
  alias: string | null
}

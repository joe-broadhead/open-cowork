import type {
  KnowledgePageBlock,
  KnowledgePageLink,
  KnowledgePageVersion,
  KnowledgeProposal,
  KnowledgeSnapshotPayload,
  KnowledgeSpace,
  KnowledgeSpaceRole,
  KnowledgeSpaceVisibility,
} from './knowledge.js'

/**
 * A value that may be produced synchronously or asynchronously. The desktop
 * SQLite store (`node:sqlite` `DatabaseSync`) is synchronous while the cloud
 * Postgres store is asynchronous, so the shared {@link KnowledgeStore} contract
 * lets a single method signature describe both — callers simply `await` the
 * result regardless of backend.
 */
export type MaybePromise<T> = T | Promise<T>

/** Options that bound the rows a snapshot/history read returns. */
export type KnowledgeStoreListOptions = {
  /** Restrict a snapshot to a single Space (ignored for history reads). */
  spaceId?: string | null
  /** Maximum rows per collection; clamped to the store's internal ceiling. */
  limit?: number | null
}

/**
 * Deterministic write knobs used by tests/contracts so both backends produce
 * identical ids/timestamps. Production callers omit these and the store mints a
 * UUID + uses the wall clock.
 */
export type KnowledgeStoreWriteOptions = {
  id?: string
  now?: Date
}

/** Input for creating a brand-new Space within a workspace. */
export type KnowledgeCreateSpaceInput = {
  name: string
  icon?: string | null
  hue?: string | null
  visibility?: KnowledgeSpaceVisibility | null
  /** The caller's role on the new Space; defaults to Maintainer (creator owns it). */
  role?: KnowledgeSpaceRole | null
}

/** Input for proposing a page create/update within a Space. */
export type KnowledgeCreateProposalInput = {
  spaceId: string
  pageId?: string | null
  pageTitle: string
  by?: string | null
  summary: string
  /** Client-supplied add/del counts are ignored — the store recomputes them. */
  add?: number | null
  del?: number | null
  links?: KnowledgePageLink[]
  body: KnowledgePageBlock[]
}

/** Input recorded against a proposal review (accept/decline) or a restore. */
export type KnowledgeReviewActionInput = {
  reviewedBy?: string | null
}

/**
 * Storage contract for the knowledge wiki. Every method is scoped to a single
 * `workspaceId` (the tenant boundary) so a backend can never read or mutate
 * another tenant's data. Implementations: a synchronous SQLite store for the
 * desktop app and an asynchronous Postgres store for multi-replica cloud.
 */
export interface KnowledgeStore {
  /** Spaces + pages + pending proposals + the derived graph for a workspace. */
  listSnapshot(
    workspaceId: string,
    options?: KnowledgeStoreListOptions,
  ): MaybePromise<KnowledgeSnapshotPayload>

  /** Newest-first published version history for a page (empty if unknown). */
  listPageHistory(
    workspaceId: string,
    pageId: string,
    options?: KnowledgeStoreListOptions,
  ): MaybePromise<KnowledgePageVersion[]>

  /** Create a new Space in the workspace and return it. */
  createSpace(
    workspaceId: string,
    input: KnowledgeCreateSpaceInput,
    options?: KnowledgeStoreWriteOptions,
  ): MaybePromise<KnowledgeSpace>

  /** A single Space by id within the workspace, or null if absent. */
  getSpaceDetail(workspaceId: string, spaceId: string): MaybePromise<KnowledgeSpace | null>

  /** Record a pending proposal (server recomputes diff stats). */
  createProposal(
    workspaceId: string,
    input: KnowledgeCreateProposalInput,
    options?: KnowledgeStoreWriteOptions,
  ): MaybePromise<KnowledgeProposal>

  /** Accept a pending proposal: publishes a versioned page + history entry. */
  acceptProposal(
    workspaceId: string,
    proposalId: string,
    input?: KnowledgeReviewActionInput,
    options?: KnowledgeStoreWriteOptions,
  ): MaybePromise<{ proposal: KnowledgeProposal; page: KnowledgePageVersion }>

  /** Decline a pending proposal without publishing a page. */
  declineProposal(
    workspaceId: string,
    proposalId: string,
    input?: KnowledgeReviewActionInput,
    options?: KnowledgeStoreWriteOptions,
  ): MaybePromise<KnowledgeProposal>

  /** Restore a historical version as a fresh, audited current version. */
  restoreVersion(
    workspaceId: string,
    pageId: string,
    versionId: string,
    input?: KnowledgeReviewActionInput,
    options?: KnowledgeStoreWriteOptions,
  ): MaybePromise<{ page: KnowledgePageVersion }>

  /** Release backend resources (e.g. close the Postgres pool). Optional. */
  close?(): MaybePromise<void>
}

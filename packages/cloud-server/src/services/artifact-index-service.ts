import type {
  ArtifactUploadReservationRecord,
  CloudArtifactIndexRecord,
  ControlPlaneStore,
  ListCloudArtifactIndexInput,
  UpsertCloudArtifactIndexInput,
  UsageEventRecord,
} from '../control-plane-store.ts'
import type { AppendProjectedEventInput } from '../session-projection-service.ts'
import type { CloudPrincipal } from '../session-service-types.ts'

type CloudArtifactIndexServiceOptions = {
  store: ControlPlaneStore
  ensurePrincipal(principal: CloudPrincipal): Promise<unknown>
  assertSessionRead(principal: CloudPrincipal, sessionId: string): Promise<void>
  appendProjectedEvent(input: AppendProjectedEventInput): Promise<unknown>
  recordUsage(input: {
    eventId: string
    orgId: string
    accountId: string | null
    eventType: 'artifact.uploaded'
    quantity: number
    unit: 'byte'
    metadata: Record<string, unknown>
  }): Promise<UsageEventRecord>
}

class ArtifactUploadUsageCollisionError extends Error {
  constructor() {
    super('Artifact upload publication usage identity collides with a different event.')
    this.name = 'ArtifactUploadUsageCollisionError'
  }
}

function finalizedUploadRecord(reservation: ArtifactUploadReservationRecord) {
  const publication = reservation.publication
  return {
    artifactId: reservation.artifactId,
    sessionId: reservation.sessionId,
    filename: reservation.filename,
    contentType: reservation.contentType,
    size: reservation.reservedBytes,
    key: reservation.finalObjectKey,
    createdAt: reservation.createdAt,
    updatedAt: reservation.createdAt,
    kind: publication.kind,
    status: publication.artifactStatus,
    authorAgentId: publication.authorAgentId,
    projectId: publication.projectId,
    taskId: publication.taskId,
    statusUpdatedBy: publication.statusUpdatedBy,
    statusUpdatedAt: publication.statusUpdatedAt,
  }
}

function finalizedUploadIndexMatches(
  indexed: CloudArtifactIndexRecord | null,
  reservation: ArtifactUploadReservationRecord,
) {
  if (
    !indexed
    || indexed.tenantId !== reservation.tenantId
    || indexed.userId !== reservation.userId
  ) return false
  const expected = finalizedUploadRecord(reservation)
  return Object.entries(expected).every(([key, value]) => (
    indexed[key as keyof typeof expected] === value
  ))
}

function finalizedUploadUsageRecord(reservation: ArtifactUploadReservationRecord) {
  return {
    eventId: `artifact.uploaded:${reservation.tenantId}:${reservation.sessionId}:${reservation.artifactId}`,
    orgId: reservation.orgId,
    // A reservation stores the product/IdP user subject, not the optional
    // cloud_accounts primary key. Keep the usage attribution org-scoped rather
    // than writing a possibly invalid account foreign key.
    accountId: null,
    eventType: 'artifact.uploaded' as const,
    quantity: reservation.reservedBytes,
    unit: 'byte' as const,
    metadata: {},
  }
}

function finalizedUploadUsageMatches(
  observed: UsageEventRecord,
  expected: ReturnType<typeof finalizedUploadUsageRecord>,
) {
  return observed.eventId === expected.eventId
    && observed.orgId === expected.orgId
    && observed.accountId === expected.accountId
    && observed.eventType === expected.eventType
    && observed.quantity === expected.quantity
    && observed.unit === expected.unit
    && Object.keys(observed.metadata).length === 0
}

export class CloudArtifactIndexService {
  private readonly options: CloudArtifactIndexServiceOptions

  constructor(options: CloudArtifactIndexServiceOptions) {
    this.options = options
  }

  async upsert(
    principal: CloudPrincipal,
    input: Omit<UpsertCloudArtifactIndexInput, 'tenantId' | 'userId'>,
  ): Promise<CloudArtifactIndexRecord> {
    await this.options.ensurePrincipal(principal)
    await this.options.assertSessionRead(principal, input.sessionId)
    return this.options.store.upsertCloudArtifactIndex({
      ...input,
      tenantId: principal.tenantId,
      userId: principal.userId,
    })
  }

  /** Publish a provider-promoted direct upload through idempotent durable seams. */
  async publishFinalizedUpload(reservation: ArtifactUploadReservationRecord) {
    const session = await this.options.store.getSessionForTenant(reservation.tenantId, reservation.sessionId)
    if (!session || session.userId !== reservation.userId) {
      throw new Error('Artifact upload publication session is no longer available.')
    }
    const record = finalizedUploadRecord(reservation)
    // Prove the deterministic accounting identity before publishing either
    // user-visible seam. A genuine collision can then exhaust into ordinary
    // object/quota cleanup without leaving an artifact that points at deleted
    // bytes; an ambiguous store error remains retryable and non-destructive.
    const expectedUsage = finalizedUploadUsageRecord(reservation)
    const recordedUsage = await this.options.recordUsage(expectedUsage)
    if (!finalizedUploadUsageMatches(recordedUsage, expectedUsage)) {
      throw new ArtifactUploadUsageCollisionError()
    }
    await this.options.appendProjectedEvent({
      tenantId: reservation.tenantId,
      sessionId: reservation.sessionId,
      eventId: `${reservation.sessionId}:artifact.created:${reservation.artifactId}`,
      type: 'artifact.created',
      payload: record,
    })
    await this.options.store.upsertCloudArtifactIndex({
      ...record,
      tenantId: reservation.tenantId,
      userId: reservation.userId,
    })
    return record
  }

  async isFinalizedUploadPublished(reservation: ArtifactUploadReservationRecord) {
    const lookup = {
      tenantId: reservation.tenantId,
      userId: reservation.userId,
      sessionId: reservation.sessionId,
      artifactId: reservation.artifactId,
    }
    const existing = await this.options.store.getCloudArtifactIndexRecord(lookup)
    if (existing && !finalizedUploadIndexMatches(existing, reservation)) {
      // A visible index that points at this reservation's promoted object is a
      // destructive-cleanup fence even when its other metadata is inconsistent.
      // An index for a different object proves only that this reservation is not
      // published and does not make deleting this reservation's bytes unsafe.
      if (existing.key === reservation.finalObjectKey) {
        throw new Error('Artifact upload publication conflicts with its existing artifact index.')
      }
      return false
    }
    // Publication crosses three independently durable, idempotent seams. An index row
    // alone cannot prove the usage event survived a crash, so recovery replays the
    // complete publication before accepting the exact index record as proof.
    try {
      await this.publishFinalizedUpload(reservation)
    } catch (error) {
      // With usage-first publication, a collision and no exact index is
      // authoritative proof that this attempt never became visible. Returning
      // false lets the lifecycle consume its retry budget and reclaim safely.
      // An exact pre-existing index is a partial publication: preserve its
      // bytes and retry non-destructively instead of authorizing cleanup.
      if (error instanceof ArtifactUploadUsageCollisionError && !existing) return false
      throw error
    }
    return finalizedUploadIndexMatches(
      await this.options.store.getCloudArtifactIndexRecord(lookup),
      reservation,
    )
  }

  async get(principal: CloudPrincipal, sessionId: string, artifactId: string) {
    await this.options.ensurePrincipal(principal)
    await this.options.assertSessionRead(principal, sessionId)
    return this.options.store.getCloudArtifactIndexRecord({
      tenantId: principal.tenantId,
      userId: principal.userId,
      sessionId,
      artifactId,
    })
  }

  async list(
    principal: CloudPrincipal,
    input: Omit<ListCloudArtifactIndexInput, 'tenantId' | 'userId'> = {},
  ) {
    await this.options.ensurePrincipal(principal)
    if (input.sessionId) await this.options.assertSessionRead(principal, input.sessionId)
    return this.options.store.listCloudArtifactIndex({
      ...input,
      tenantId: principal.tenantId,
      userId: principal.userId,
    })
  }
}

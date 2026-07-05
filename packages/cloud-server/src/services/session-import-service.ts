// Session import write paths, carved out of the CloudSessionService god class (ARCH
// god-class). createImportedSession/completeSessionImport/recordImportFailed carry the
// real body logic — audit trail, billing gating, projected-event replay of imported
// messages/todos/cost — moved verbatim so behavior is byte-identical; CloudSessionService
// keeps thin delegators.
import type { ControlPlaneStore, SessionEventRecord, SessionRecord } from '../control-plane-store.ts'
import { type CloudRuntimePolicy } from '../cloud-config.ts'
import type { BillingAction } from '../billing-adapter.ts'
import type { AppendProjectedEventInput } from '../session-projection-service.ts'
import { CloudServiceError } from '../cloud-service-error.ts'
import {
  assertSafeSessionImportPayload,
  type SessionImportItemCounts,
  type SessionImportRequest,
} from '@open-cowork/shared'
import { boundedImportText, normalizeImportCounts } from '../session-import-validation.ts'
import {
  SESSION_IMPORT_MAX_MESSAGES,
  importAuditActor,
  type CloudPrincipal,
  type CloudSessionView,
  type CreateCloudSessionRecordInput,
} from '../session-service-types.ts'

export type CloudSessionImportServiceOptions = {
  store: ControlPlaneStore
  policy: CloudRuntimePolicy
  ids: { randomUUID: () => string }
  ensurePrincipal: (principal: CloudPrincipal) => Promise<void>
  principalOrgId: (principal: CloudPrincipal) => string
  assertBillingAllowed: (input: {
    orgId: string
    action: BillingAction
    profileName?: string | null
    providerId?: string | null
  }) => Promise<void>
  createCloudSessionRecord: (input: CreateCloudSessionRecordInput) => Promise<SessionRecord>
  appendProjectedEvent: (input: AppendProjectedEventInput) => Promise<SessionEventRecord>
  getSessionView: (principal: CloudPrincipal, sessionId: string) => Promise<CloudSessionView>
}

export class CloudSessionImportService {
  private readonly store: ControlPlaneStore
  private readonly policy: CloudRuntimePolicy
  private readonly ids: { randomUUID: () => string }
  private readonly ensurePrincipal: CloudSessionImportServiceOptions['ensurePrincipal']
  private readonly principalOrgId: CloudSessionImportServiceOptions['principalOrgId']
  private readonly assertBillingAllowed: CloudSessionImportServiceOptions['assertBillingAllowed']
  private readonly createCloudSessionRecord: CloudSessionImportServiceOptions['createCloudSessionRecord']
  private readonly appendProjectedEvent: CloudSessionImportServiceOptions['appendProjectedEvent']
  private readonly getSessionView: CloudSessionImportServiceOptions['getSessionView']

  constructor(options: CloudSessionImportServiceOptions) {
    this.store = options.store
    this.policy = options.policy
    this.ids = options.ids
    this.ensurePrincipal = options.ensurePrincipal
    this.principalOrgId = options.principalOrgId
    this.assertBillingAllowed = options.assertBillingAllowed
    this.createCloudSessionRecord = options.createCloudSessionRecord
    this.appendProjectedEvent = options.appendProjectedEvent
    this.getSessionView = options.getSessionView
  }

  async createImportedSession(principal: CloudPrincipal, input: SessionImportRequest): Promise<CloudSessionView> {
    await this.ensurePrincipal(principal)
    if (!this.policy.features.chat) throw new Error('Chat is disabled for this cloud profile.')
    try {
      assertSafeSessionImportPayload(input)
    } catch (error) {
      throw new CloudServiceError(400, error instanceof Error ? error.message : 'Session import payload is unsafe.')
    }
    const source = input.source
    if (!source || source.kind !== 'local-session' || !source.fingerprint) {
      throw new CloudServiceError(400, 'Session import requires a redacted local source fingerprint.')
    }
    const profileName = input.profileName || this.policy.profileName
    await this.assertBillingAllowed({
      orgId: this.principalOrgId(principal),
      action: 'session.create',
      profileName,
    })
    const itemCounts = normalizeImportCounts(input.itemCounts)
    const actor = importAuditActor(principal)
    await this.store.recordAuditEvent({
      orgId: this.principalOrgId(principal),
      accountId: actor.accountId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      eventType: 'session_import.requested',
      targetType: 'session',
      targetId: null,
      metadata: {
        sourceKind: source.kind,
        sourceFingerprint: source.fingerprint,
        title: boundedImportText(input.title, 'Import title', 512),
        itemCounts,
      },
    })

    try {
      const title = boundedImportText(input.title, 'Import title', 512) || source.title || 'Imported session'
      const session = await this.createCloudSessionRecord({
        tenantId: principal.tenantId,
        userId: principal.userId,
        orgId: this.principalOrgId(principal),
        accountId: principal.accountId || principal.userId,
        profileName,
        sessionId: this.ids.randomUUID(),
        title,
      })
      const importedAt = new Date()
      await this.appendProjectedEvent({
        tenantId: principal.tenantId,
        sessionId: session.sessionId,
        type: 'session.imported',
        payload: {
          sourceFingerprint: source.fingerprint,
          importedAt: importedAt.toISOString(),
          itemCounts,
        },
        createdAt: importedAt,
      })

      const messages = Array.isArray(input.messages) ? input.messages.slice(0, SESSION_IMPORT_MAX_MESSAGES) : []
      for (const message of messages) {
        if (message.role !== 'user' && message.role !== 'assistant') continue
        const content = boundedImportText(message.content, 'Imported message')
        const createdAt = message.timestamp ? new Date(message.timestamp) : importedAt
        await this.appendProjectedEvent({
          tenantId: principal.tenantId,
          sessionId: session.sessionId,
          type: message.role === 'user' ? 'prompt.submitted' : 'assistant.message',
          payload: message.role === 'user'
            ? {
                messageId: message.id,
                text: content,
                imported: true,
                attachments: Array.isArray(message.attachments) ? message.attachments : [],
              }
            : {
                messageId: message.id,
                content,
                imported: true,
                attachments: Array.isArray(message.attachments) ? message.attachments : [],
              },
          createdAt: Number.isFinite(createdAt.getTime()) ? createdAt : importedAt,
        })
      }

      const todos = Array.isArray(input.todos) ? input.todos.slice(0, 500) : []
      if (todos.length) {
        await this.appendProjectedEvent({
          tenantId: principal.tenantId,
          sessionId: session.sessionId,
          type: 'todos.updated',
          payload: { todos },
          createdAt: importedAt,
        })
      }

      if (input.sessionCost || input.sessionTokens) {
        await this.appendProjectedEvent({
          tenantId: principal.tenantId,
          sessionId: session.sessionId,
          type: 'cost.updated',
          payload: {
            cost: typeof input.sessionCost === 'number' && Number.isFinite(input.sessionCost) ? input.sessionCost : 0,
            tokens: input.sessionTokens || {},
            imported: true,
          },
          createdAt: importedAt,
        })
      }

      await this.appendProjectedEvent({
        tenantId: principal.tenantId,
        sessionId: session.sessionId,
        type: 'session.idle',
        payload: { imported: true },
        createdAt: importedAt,
      })

      return this.getSessionView(principal, session.sessionId)
    } catch (error) {
      await this.recordImportFailed(principal, {
        sourceFingerprint: source.fingerprint,
        itemCounts,
        error,
      })
      throw error
    }
  }

  async completeSessionImport(
    principal: CloudPrincipal,
    sessionId: string,
    input: { sourceFingerprint: string, itemCounts: SessionImportItemCounts },
  ) {
    await this.getSessionView(principal, sessionId)
    const actor = importAuditActor(principal)
    await this.store.recordAuditEvent({
      orgId: this.principalOrgId(principal),
      accountId: actor.accountId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      eventType: 'session_import.completed',
      targetType: 'session',
      targetId: sessionId,
      metadata: {
        sourceKind: 'local-session',
        sourceFingerprint: input.sourceFingerprint,
        destinationSessionId: sessionId,
        itemCounts: normalizeImportCounts(input.itemCounts),
      },
    })
  }

  async recordImportFailed(
    principal: CloudPrincipal,
    input: { sourceFingerprint: string, itemCounts?: Partial<SessionImportItemCounts>, sessionId?: string | null, error: unknown },
  ) {
    const actor = importAuditActor(principal)
    const message = input.error instanceof Error ? input.error.message : String(input.error)
    await this.store.recordAuditEvent({
      orgId: this.principalOrgId(principal),
      accountId: actor.accountId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      eventType: 'session_import.failed',
      targetType: input.sessionId ? 'session' : null,
      targetId: input.sessionId || null,
      metadata: {
        sourceKind: 'local-session',
        sourceFingerprint: input.sourceFingerprint,
        destinationSessionId: input.sessionId || null,
        itemCounts: normalizeImportCounts(input.itemCounts),
        error: boundedImportText(message, 'Import error', 512),
      },
    })
  }
}

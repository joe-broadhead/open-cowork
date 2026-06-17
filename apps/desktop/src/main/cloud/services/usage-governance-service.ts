import { createHash } from 'node:crypto'
import type { CloudAbuseConfig, CloudBillingConfig, CloudBillingEntitlements } from '../../config-types.ts'
import { CloudServiceError } from '../cloud-service-error.ts'
import { ControlPlaneQuotaExceededError, type QuotaPolicyCode } from '../control-plane-errors.ts'
import type {
  ConsumeUsageQuotaInput,
  ControlPlaneStore,
  UsageEventRecord,
} from '../control-plane-store.ts'
import {
  isBillingConfigured,
  resolvedBillingEntitlements,
} from '../billing-adapter.ts'
import type {
  CloudUsageQuotaWindowRecord,
  CloudUsageSummary,
  CloudUsageTotalRecord,
} from '../session-service.ts'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

type EntitlementLimitKey =
  | 'maxConcurrentSessionsPerOrg'
  | 'maxConcurrentWorkflowRunsPerOrg'
  | 'maxActiveWorkersPerOrg'
  | 'maxQueuedCommandsPerOrg'
  | 'maxQueueAgeMs'
  | 'maxPromptsPerHour'
  | 'maxWorkflowRunsPerHour'
  | 'maxGatewayPromptsPerHour'
  | 'maxWorkerMinutesPerHour'
  | 'maxGatewayDeliveriesPerHour'
  | 'maxGatewayChannelBindingsPerOrg'
  | 'maxArtifactBytesPerDay'

type WindowedEntitlementLimitKey = Extract<
  EntitlementLimitKey,
  | 'maxPromptsPerHour'
  | 'maxWorkflowRunsPerHour'
  | 'maxGatewayPromptsPerHour'
  | 'maxWorkerMinutesPerHour'
  | 'maxGatewayDeliveriesPerHour'
  | 'maxArtifactBytesPerDay'
>

function windowStartMs(nowMs: number, windowMs: number) {
  return Math.floor(nowMs / windowMs) * windowMs
}

function hashOperationalId(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

export class CloudUsageGovernanceService {
  private readonly store: ControlPlaneStore
  private readonly abuse: CloudAbuseConfig
  private readonly billingConfig: CloudBillingConfig | null

  constructor(input: {
    store: ControlPlaneStore
    abuse: CloudAbuseConfig
    billingConfig: CloudBillingConfig | null
  }) {
    this.store = input.store
    this.abuse = input.abuse
    this.billingConfig = input.billingConfig
  }

  quotaLimit(value: number | null | undefined) {
    if (!this.abuse.enabled) return null
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
  }

  quotaError(message: string, policyCode: QuotaPolicyCode | string, retryAfterMs: number | null) {
    return new CloudServiceError(429, message, { policyCode, retryAfterMs })
  }

  translateQuotaError(error: unknown, fallbackMessage: string, fallbackPolicyCode: QuotaPolicyCode | string): never {
    if (error instanceof ControlPlaneQuotaExceededError) {
      throw this.quotaError(
        error.publicMessage || fallbackMessage,
        error.policyCode || fallbackPolicyCode,
        error.retryAfterMs,
      )
    }
    throw error
  }

  // One subscription round-trip → resolved entitlements (or null when billing is off / the org
  // has no subscription). Callers that need several entitlement limits for the same org should
  // resolve once via this and read each key with `limitFromEntitlements`, instead of calling
  // `effectiveQuotaLimit` per key (which would re-fetch the subscription each time).
  private async resolveOrgEntitlements(orgId: string): Promise<CloudBillingEntitlements | null> {
    if (!this.billingConfig || !isBillingConfigured(this.billingConfig)) return null
    const subscription = await this.store.getBillingSubscription(orgId)
    if (!subscription) return null
    return resolvedBillingEntitlements(this.billingConfig, subscription)
  }

  private limitFromEntitlements(
    entitlements: CloudBillingEntitlements | null,
    fallback: number | null | undefined,
    key?: EntitlementLimitKey,
  ) {
    if (!key || !entitlements) return fallback
    const value = entitlements[key]
    return value === undefined ? fallback : value
  }

  async effectiveQuotaLimit(
    orgId: string,
    fallback: number | null | undefined,
    key?: EntitlementLimitKey,
  ) {
    if (!key) return fallback
    return this.limitFromEntitlements(await this.resolveOrgEntitlements(orgId), fallback, key)
  }

  async consumeQuota(input: {
    orgId: string
    quotaKey: string
    limit: number | null | undefined
    entitlementLimitKey?: WindowedEntitlementLimitKey
    quantity?: number
    windowMs: number
    policyCode: QuotaPolicyCode
    message: string
  }) {
    const limit = this.quotaLimit(await this.effectiveQuotaLimit(
      input.orgId,
      input.limit,
      input.entitlementLimitKey,
    ))
    if (!limit) return null
    const result = await this.store.consumeUsageQuota({
      orgId: input.orgId,
      quotaKey: input.quotaKey,
      limit,
      quantity: input.quantity,
      windowMs: input.windowMs,
      policyCode: input.policyCode,
    })
    if (!result.allowed) {
      throw this.quotaError(input.message, input.policyCode, result.retryAfterMs)
    }
    return result
  }

  async usageQuotaForOrg(input: {
    orgId: string
    quotaKey: string
    limit: number | null | undefined
    entitlementLimitKey?: WindowedEntitlementLimitKey
    quantity?: number
    windowMs: number
    policyCode: QuotaPolicyCode
  }): Promise<ConsumeUsageQuotaInput | null> {
    const limit = this.quotaLimit(await this.effectiveQuotaLimit(
      input.orgId,
      input.limit,
      input.entitlementLimitKey,
    ))
    if (!limit) return null
    return {
      orgId: input.orgId,
      quotaKey: input.quotaKey,
      limit,
      quantity: input.quantity,
      windowMs: input.windowMs,
      policyCode: input.policyCode,
    }
  }

  async commandQueueQuotaForOrg(orgId: string) {
    // Single subscription fetch for both entitlement limits (was two, on the prompt hot path).
    const entitlements = await this.resolveOrgEntitlements(orgId)
    return {
      orgId,
      maxQueuedCommandsPerOrg: this.quotaLimit(this.limitFromEntitlements(
        entitlements,
        this.abuse.maxQueuedCommandsPerOrg,
        'maxQueuedCommandsPerOrg',
      )),
      maxQueueAgeMs: this.quotaLimit(this.limitFromEntitlements(
        entitlements,
        this.abuse.maxQueueAgeMs,
        'maxQueueAgeMs',
      )),
      policyCode: 'quota.queued_commands_exceeded',
      queueAgePolicyCode: 'quota.queue_age_exceeded',
    }
  }

  async workflowRunQuotaForOrg(orgId: string) {
    // Single subscription fetch for both entitlement limits (was two).
    const entitlements = await this.resolveOrgEntitlements(orgId)
    return {
      orgId,
      maxConcurrentWorkflowRunsPerOrg: this.quotaLimit(this.limitFromEntitlements(
        entitlements,
        this.abuse.maxConcurrentWorkflowRunsPerOrg,
        'maxConcurrentWorkflowRunsPerOrg',
      )),
      maxWorkflowRunsPerHour: this.quotaLimit(this.limitFromEntitlements(
        entitlements,
        this.abuse.maxWorkflowRunsPerHour,
        'maxWorkflowRunsPerHour',
      )),
      policyCode: 'quota.concurrent_workflow_runs_exceeded',
      workflowRunsPolicyCode: 'quota.workflow_runs_per_hour_exceeded',
    }
  }

  workflowRunDefaultQuota() {
    return {
      maxConcurrentWorkflowRunsPerOrg: this.quotaLimit(this.abuse.maxConcurrentWorkflowRunsPerOrg),
      maxWorkflowRunsPerHour: this.quotaLimit(this.abuse.maxWorkflowRunsPerHour),
      policyCode: 'quota.concurrent_workflow_runs_exceeded',
      workflowRunsPolicyCode: 'quota.workflow_runs_per_hour_exceeded',
    }
  }

  async recordUsage(input: {
    orgId: string
    accountId?: string | null
    eventType: UsageEventRecord['eventType']
    quantity?: number
    unit?: UsageEventRecord['unit']
    metadata?: Record<string, unknown>
  }) {
    if (!this.abuse.enabled) return null
    return this.store.recordUsageEvent(input)
  }

  async recordManagedWorkClaimed(input: {
    tenantId: string
    sessionId: string
    workerId: string
    leaseToken: string
  }) {
    const org = await this.store.ensureOrgForTenant({ tenantId: input.tenantId, name: input.tenantId })
    return this.recordUsage({
      orgId: org.orgId,
      eventType: 'work.claimed',
      unit: 'count',
      metadata: {
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        workerId: input.workerId,
        leaseTokenHash: hashOperationalId(input.leaseToken),
      },
    })
  }

  async recordManagedExecutionEvent(input: {
    tenantId: string
    sessionId: string
    workerId: string
    commandId: string
    commandKind: string
    eventType: 'worker.execution_started' | 'worker.execution_completed' | 'worker.execution_failed'
    elapsedMs?: number | null
    errorCode?: string | null
  }) {
    const org = await this.store.ensureOrgForTenant({ tenantId: input.tenantId, name: input.tenantId })
    return this.recordUsage({
      orgId: org.orgId,
      eventType: input.eventType,
      unit: 'count',
      metadata: {
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        workerId: input.workerId,
        commandId: input.commandId,
        commandKind: input.commandKind,
        elapsedMs: input.elapsedMs === undefined || input.elapsedMs === null ? null : Math.max(0, Math.round(input.elapsedMs)),
        errorCode: input.errorCode || null,
      },
    })
  }

  async getUsageSummary(orgId: string, limit = 100): Promise<CloudUsageSummary> {
    const now = Date.now()
    const [events, counters] = await Promise.all([
      this.store.listUsageEvents(orgId, limit),
      this.store.listUsageQuotaCounters(orgId),
    ])
    const totals = new Map<string, CloudUsageTotalRecord>()
    for (const event of events) {
      const totalKey = `${event.eventType}\0${event.unit}`
      const total = totals.get(totalKey) || { eventType: event.eventType, unit: event.unit, quantity: 0 }
      total.quantity += event.quantity
      totals.set(totalKey, total)
    }
    const counterByKey = new Map(counters.map((counter) => [counter.quotaKey, counter]))
    const quotaInputs: Array<{
      quotaKey: string
      label: string
      unit: CloudUsageQuotaWindowRecord['unit']
      limit: number | null | undefined
      entitlementLimitKey?: WindowedEntitlementLimitKey
      windowMs: number
      policyCode: string
    }> = [
      ['prompts:hour', 'Prompts per hour', 'count', this.abuse.maxPromptsPerHour, 'maxPromptsPerHour', HOUR_MS, 'quota.prompts_per_hour_exceeded'],
      ['workflow_runs:hour', 'Workflow runs per hour', 'count', this.abuse.maxWorkflowRunsPerHour, 'maxWorkflowRunsPerHour', HOUR_MS, 'quota.workflow_runs_per_hour_exceeded'],
      ['gateway_prompts:hour', 'Gateway prompts per hour', 'count', this.abuse.maxGatewayPromptsPerHour, 'maxGatewayPromptsPerHour', HOUR_MS, 'quota.gateway_prompts_per_hour_exceeded'],
      ['gateway_deliveries:hour', 'Gateway deliveries per hour', 'count', this.abuse.maxGatewayDeliveriesPerHour, 'maxGatewayDeliveriesPerHour', HOUR_MS, 'quota.gateway_deliveries_per_hour_exceeded'],
      ['worker_minutes:hour', 'Worker minutes per hour', 'minute', this.abuse.maxWorkerMinutesPerHour, 'maxWorkerMinutesPerHour', HOUR_MS, 'quota.worker_minutes_per_hour_exceeded'],
      ['artifact_bytes:day', 'Artifact bytes per day', 'byte', this.abuse.maxArtifactBytesPerDay, 'maxArtifactBytesPerDay', DAY_MS, 'quota.artifact_bytes_per_day_exceeded'],
    ].map(([quotaKey, label, unit, quotaLimit, entitlementLimitKey, windowMs, policyCode]) => ({
      quotaKey: String(quotaKey),
      label: String(label),
      unit: unit as CloudUsageQuotaWindowRecord['unit'],
      limit: quotaLimit as number | null | undefined,
      entitlementLimitKey: entitlementLimitKey as WindowedEntitlementLimitKey,
      windowMs: Number(windowMs),
      policyCode: String(policyCode),
    }))
    const quotas: CloudUsageQuotaWindowRecord[] = []
    for (const input of quotaInputs) {
      const rawLimit = await this.effectiveQuotaLimit(orgId, input.limit, input.entitlementLimitKey)
      const effectiveLimit = this.quotaLimit(rawLimit)
      const fallbackWindowStart = windowStartMs(now, input.windowMs)
      const counter = counterByKey.get(input.quotaKey)
      const counterWindowStart = counter?.windowStartedAtMs === fallbackWindowStart ? counter.windowStartedAtMs : fallbackWindowStart
      const used = counter && counter.windowStartedAtMs === fallbackWindowStart ? counter.quantity : 0
      quotas.push({
        quotaKey: input.quotaKey,
        label: input.label,
        unit: input.unit,
        enabled: Boolean(this.abuse.enabled && effectiveLimit),
        limit: effectiveLimit,
        used,
        remaining: effectiveLimit ? Math.max(0, effectiveLimit - used) : null,
        windowMs: input.windowMs,
        windowStartedAt: new Date(counterWindowStart).toISOString(),
        resetAt: new Date(counterWindowStart + input.windowMs).toISOString(),
        policyCode: input.policyCode,
      })
    }
    return {
      enabled: this.abuse.enabled,
      generatedAt: new Date(now).toISOString(),
      totalsScope: 'recent_events',
      eventSampleLimit: limit,
      events,
      totals: [...totals.values()].sort((left, right) => left.eventType.localeCompare(right.eventType) || left.unit.localeCompare(right.unit)),
      quotas,
    }
  }
}

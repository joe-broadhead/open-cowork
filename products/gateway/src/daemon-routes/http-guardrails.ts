import { createHash } from 'node:crypto'
import { json } from '../daemon-router.js'
import { getConfig } from '../config.js'
import { redactSensitiveText } from '../security.js'
import { stableStringify } from '../stable-stringify.js'
import { appendAuditEvent, consumeHumanGate, createHumanGate, ensureHumanGate, getHumanGate } from '../work-store.js'

export interface HttpCallerIdentity {
  actor: string
  source: string
  claimedActor?: string
}

export function httpCallerIdentity(req: any): HttpCallerIdentity {
  const claimedActor = normalizeClaimedActor(req?.headers?.['x-gateway-actor'])
  const fingerprint = bearerFingerprint(req?.headers?.authorization)
  if (fingerprint) return { actor: `http-token:${fingerprint}`, source: 'http-token', claimedActor }

  const surface = String(req?.headers?.['x-gateway-request-surface'] || '').trim().toLowerCase()
  if (surface === 'mcp') return { actor: 'mcp', source: 'mcp', claimedActor }
  return { actor: 'http', source: 'http', claimedActor }
}

export function httpRequestSource(req: any): string {
  const identity = httpCallerIdentity(req)
  const remote = redactSensitiveText(String(req?.socket?.remoteAddress || 'unknown'))
  const host = redactSensitiveText(String(req?.headers?.host || 'unknown'))
  return `${identity.source} ${remote} host=${host}`
}

export function auditHttp(req: any, operation: string, target: string, result: 'ok' | 'denied' | 'error', details: Record<string, unknown> = {}): void {
  try {
    const identity = httpCallerIdentity(req)
    appendAuditEvent({
      actor: identity.actor,
      source: httpRequestSource(req),
      operation,
      target,
      result,
      details: identity.claimedActor ? { ...details, claimedActor: identity.claimedActor } : details,
    })
  } catch {}
}

export function requireDestructiveHttpApproval(req: any, body: any, operation: string, target: string) {
  const config = getConfig()
  if (!config.humanLoop.enabled || !config.humanLoop.destructiveActionApproval) return null
  const approvedGateId = String(body?.approvedGateId || body?.gateId || '').trim()
  const payload = stripApprovalFields(body)
  const scopeKey = destructiveApprovalScopeKey(operation, target, payload)
  if (approvedGateId) {
    const gate = getHumanGate(approvedGateId)
    if (gate?.type === 'destructive_action' && gate.status === 'approved' && gate.scopeKey === scopeKey) return null
    auditHttp(req, operation, target, 'denied', { scopeKey })
    return json({
      error: 'destructive action approval is required',
      message: 'approvedGateId does not reference an approved destructive-action gate for this exact operation and payload.',
      scopeKey,
    }, 428)
  }

  const identity = httpCallerIdentity(req)
  const gateInput = {
    type: 'destructive_action' as const,
    reason: `Approve ${operation} for ${target}`,
    requestedBy: identity.actor,
    scopeKey,
    details: {
      operation,
      target,
      method: req.method,
      route: req.url,
      source: identity.source,
      ...(identity.claimedActor ? { claimedActor: identity.claimedActor } : {}),
    },
  }
  const gate = ensureHumanGate(gateInput) || createHumanGate(gateInput)
  auditHttp(req, operation, target, 'denied', { scopeKey, gateId: gate.id })
  return json({
    error: 'destructive action approval is required',
    gate,
    nextAction: `Approve gate ${gate.id}, then retry this request with approvedGateId=${gate.id}.`,
  }, 428)
}

export function consumeDestructiveHttpApproval(req: any, body: any, operation: string): void {
  const approvedGateId = String(body?.approvedGateId || body?.gateId || '').trim()
  if (!approvedGateId) return
  const identity = httpCallerIdentity(req)
  consumeHumanGate(approvedGateId, {
    actor: identity.actor,
    source: identity.source,
    note: `${operation} completed`,
  })
}

export function stripApprovalFields(body: any): Record<string, unknown> {
  const { approvedGateId: _approvedGateId, gateId: _gateId, ...rest } = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  return rest
}

export function destructiveApprovalScopeKey(operation: string, target: string, payload: Record<string, unknown>): string {
  const payloadHash = createHash('sha256').update(stableStringify(payload)).digest('hex').slice(0, 24)
  return `admin:${operation}:${target}:${payloadHash}`
}

function bearerFingerprint(header: unknown): string | undefined {
  const value = Array.isArray(header) ? header[0] : header
  const match = String(value || '').match(/^Bearer\s+(.+)$/i)
  const token = match?.[1]?.trim()
  return token ? createHash('sha256').update(token).digest('hex').slice(0, 12) : undefined
}

function normalizeClaimedActor(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  const actor = String(raw || '').trim()
  return actor ? actor.slice(0, 120) : undefined
}

/**
 * Environment run lifecycle helpers (JOE-936 / JOE-919).
 * Leaf module — no import from environments.ts.
 */
import type {
  EnvironmentAcquisitionLookupResult,
  EnvironmentAcquisitionReleaseResult,
  EnvironmentBackend,
  EnvironmentReconciliationResult,
  EnvironmentRunRecord,
  EnvironmentSpec,
} from './types.js'
import {
  environmentIdempotencyKeyHash,
  normalizeEnvironmentIdempotencyKey,
  redactEnvironmentNetworkTargets,
  shortText,
} from './util.js'

type Controller = {
  retain: (environment: EnvironmentRunRecord) => EnvironmentRunRecord
  release: (environment: EnvironmentRunRecord) => EnvironmentRunRecord
}

let controllerResolver: ((backend: EnvironmentBackend) => Controller) | undefined

export function setEnvironmentControllerResolver(resolver: (backend: EnvironmentBackend) => Controller): void {
  controllerResolver = resolver
}

export function lookupMetadataEnvironmentAcquisition(spec: EnvironmentSpec, idempotencyKey: string): EnvironmentAcquisitionLookupResult {
  const key = normalizeEnvironmentIdempotencyKey(idempotencyKey)
  return {
    ok: true,
    found: false,
    backend: spec.backend,
    idempotencyKeyHash: environmentIdempotencyKeyHash(key),
    metadata: {},
    evidence: [`${spec.backend} has no external acquisition to look up by key`],
  }
}

export function releaseMetadataEnvironmentAcquisition(spec: EnvironmentSpec, idempotencyKey: string): EnvironmentAcquisitionReleaseResult {
  const key = normalizeEnvironmentIdempotencyKey(idempotencyKey)
  return {
    ok: true,
    found: false,
    released: false,
    backend: spec.backend,
    idempotencyKeyHash: environmentIdempotencyKeyHash(key),
    evidence: [`${spec.backend} has no external acquisition to release by key`],
  }
}


export function finalizeEnvironmentRun(environment: EnvironmentRunRecord | undefined, success: boolean): EnvironmentRunRecord | undefined {
  if (!environment) return undefined
  const retain = success ? environment.cleanup.retainOnSuccess : environment.cleanup.retainOnFailure
  const controller = controllerResolver?.(environment.backend)
  if (!controller) throw new Error('environment controller resolver not configured')
  try {
    return retain ? controller.retain(environment) : controller.release(environment)
  } catch (err: any) {
    return cleanupFailedEnvironmentRun(environment, err?.message || String(err))
  }
}

export function releaseEnvironmentRun(environment: EnvironmentRunRecord): EnvironmentRunRecord {
  return updateEnvironmentLifecycle(environment, 'released', 'released')
}

export function retainEnvironmentRun(environment: EnvironmentRunRecord): EnvironmentRunRecord {
  return updateEnvironmentLifecycle(environment, 'retained', 'retained')
}

export function cleanupFailedEnvironmentRun(environment: EnvironmentRunRecord, reason: string): EnvironmentRunRecord {
  return {
    ...updateEnvironmentLifecycle(environment, 'cleanup_failed', 'failed'),
    metadata: { ...environment.metadata, cleanupError: shortText(reason, 500) },
  }
}

export function updateEnvironmentLifecycle(environment: EnvironmentRunRecord, status: EnvironmentRunRecord['status'], state: EnvironmentRunRecord['cleanup']['state']): EnvironmentRunRecord {
  return {
    ...environment,
    status,
    updatedAt: new Date().toISOString(),
    cleanup: { ...environment.cleanup, state },
  }
}

export function reconcileEnvironmentRuns(environments: EnvironmentRunRecord[]): EnvironmentReconciliationResult {
  const active = environments.filter(environment => environment.status === 'prepared' || environment.status === 'blocked')
  const retained = environments.filter(environment => environment.status === 'retained')
  const cleanupFailed = environments.filter(environment => environment.status === 'cleanup_failed')
  return {
    ok: cleanupFailed.length === 0,
    checked: environments.length,
    active: active.length,
    retained: retained.length,
    cleanupFailed: cleanupFailed.length,
    evidence: [`checked=${environments.length}`, `active=${active.length}`, `retained=${retained.length}`, `cleanupFailed=${cleanupFailed.length}`],
  }
}

export function environmentPromptContext(spec: EnvironmentSpec, run: EnvironmentRunRecord): string {
  const networkAllow = redactEnvironmentNetworkTargets(spec.network.allow || [])
  const lines = [
    'Execution environment contract:',
    `- Environment: ${spec.name} (${spec.backend})`,
    spec.workdir ? `- Workdir: ${spec.workdir}` : '',
    spec.tools.length ? `- Required tools declared for environment: ${spec.tools.join(', ')}` : '- Required tools declared for environment: none',
    `- Network policy: ${spec.network.mode}${networkAllow.length ? ` allow=${networkAllow.join(',')}` : ''}`,
    run.preflight.warnings.length ? `- Warnings: ${run.preflight.warnings.join('; ')}` : '',
  ]
  if (spec.backend === 'local-container') {
    const prefix = Array.isArray(run.metadata['commandPrefix']) ? run.metadata['commandPrefix'].map(String).join(' ') : `${spec.container?.runtime || 'docker'} run ... ${spec.container?.image || '(image not set)'}`
    lines.push(`- Run repository commands through the configured container runtime/image: ${spec.container?.runtime || 'docker'} ${spec.container?.image || '(image not set)'}`)
    lines.push(`- Container command prefix: ${prefix}`)
  }
  if (spec.backend === 'remote-crabbox') {
    const prefix = Array.isArray(run.metadata['commandPrefix']) ? run.metadata['commandPrefix'].map(String).join(' ') : `${spec.crabbox?.cli || 'crabbox'} run --id ${run.leaseId || '<lease-id>'} -- ...`
    lines.push(`- Remote Crabbox lease: ${run.leaseId || '(not leased)'}${run.metadata['slug'] ? ` slug=${run.metadata['slug']}` : ''}`)
    lines.push(`- Run repository commands through Crabbox so source sync, logs, timing, and artifacts stay attached to this lease.`)
    lines.push(`- Crabbox command prefix: ${prefix}`)
    lines.push(`- For multi-command shell snippets use: ${spec.crabbox?.cli || 'crabbox'} run --id ${run.leaseId || '<lease-id>'} --shell '<command>'`)
  }
  return lines.filter(Boolean).join('\n')
}

import type { ServerResponse } from 'node:http'

import type { CloudRuntimePolicy } from './cloud-config.ts'
import type { CloudProgressWatchdogSnapshot } from './progress-watchdog.ts'
import type { CloudReadinessReport } from './readiness.ts'
import { writeJson } from './http-response-writers.ts'

export async function handleCloudHealthRoute(input: {
  pathname: string
  res: ServerResponse
  corsOrigin?: string | null
  policy: Pick<CloudRuntimePolicy, 'role' | 'profileName'>
  draining: boolean
  readiness?: () => Promise<CloudReadinessReport> | CloudReadinessReport
  progress?: () => Promise<CloudProgressWatchdogSnapshot> | CloudProgressWatchdogSnapshot
}): Promise<boolean> {
  if (input.pathname === '/livez') {
    writeJson(input.res, 200, {
      ok: true,
      role: input.policy.role,
      profileName: input.policy.profileName,
    }, input.corsOrigin)
    return true
  }
  if (input.pathname === '/progressz') {
    if (!input.progress) {
      writeJson(input.res, 200, {
        mode: 'off',
        requestedMode: 'off',
        configStatus: 'valid',
        configReason: 'default_off',
        counts: { healthy: 0, waiting: 0, suspect: 0, stalled: 0 },
        samples: [],
        truncated: false,
      } satisfies CloudProgressWatchdogSnapshot, input.corsOrigin)
      return true
    }
    try {
      writeJson(input.res, 200, await input.progress(), input.corsOrigin)
    } catch {
      writeJson(input.res, 503, { ok: false, error: 'progress_snapshot_unavailable' }, input.corsOrigin)
    }
    return true
  }
  if (input.pathname !== '/readyz') return false
  if (input.draining) {
    writeJson(input.res, 503, {
      ok: false,
      role: input.policy.role,
      profileName: input.policy.profileName,
      checks: [{ name: 'draining', status: 'error', detail: 'Server is shutting down.' }],
    }, input.corsOrigin)
    return true
  }
  const readiness = input.readiness
    ? await input.readiness()
    : {
        ok: false,
        role: input.policy.role,
        profileName: input.policy.profileName,
        checks: [{
          name: 'readiness_config',
          status: 'error',
          detail: 'Readiness checks are not configured for this server.',
        }],
      } satisfies CloudReadinessReport
  writeJson(input.res, readiness.ok ? 200 : 503, readiness, input.corsOrigin)
  return true
}

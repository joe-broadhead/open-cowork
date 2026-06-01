import type { ControlPlaneMembershipStatus, ControlPlaneRole, ManagedWorkerStatus } from '../control-plane-store.ts'
import type { CloudApiRouteInput } from './types.ts'

function memberRole(value: unknown): ControlPlaneRole | null {
  return value === 'owner' || value === 'admin' || value === 'member' ? value : null
}

function memberStatus(value: unknown): ControlPlaneMembershipStatus | null {
  return value === 'active' || value === 'invited' || value === 'disabled' ? value : null
}

function poolMode(value: unknown) {
  return value === 'saas_operated' || value === 'self_hosted'
    ? value
    : null
}

function poolStatus(value: unknown) {
  return value === 'active' || value === 'paused' || value === 'retired' ? value : null
}

function workerStatus(value: unknown) {
  return value === 'pending'
    || value === 'active'
    || value === 'draining'
    || value === 'paused'
    || value === 'retired'
    || value === 'revoked'
    || value === 'unhealthy'
    ? value
    : null
}

function nullableNumber(value: unknown) {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

export async function handleAdminApiRoute(input: CloudApiRouteInput): Promise<boolean> {
  const { req, res, options, context, itemId, action, artifactId, tools } = input

  if (!itemId && req.method === 'GET') {
    tools.writeJson(res, 200, {
      policy: await options.service.getAdminPolicyOverview(context.principal),
    }, options.corsOrigin)
    return true
  }

  if (itemId === 'policy' && !action && req.method === 'GET') {
    tools.writeJson(res, 200, {
      policy: await options.service.getAdminPolicyOverview(context.principal),
    }, options.corsOrigin)
    return true
  }

  if (itemId === 'members') {
    if (!action && req.method === 'GET') {
      tools.writeJson(res, 200, {
        members: await options.service.listOrgMembers(context.principal, {
          query: context.url.searchParams.get('q'),
          limit: tools.parseLimit(context.url),
        }),
      }, options.corsOrigin)
      return true
    }
    if (!action && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const email = tools.readString(body.email)
      const role = memberRole(body.role) || 'member'
      if (!email) {
        tools.writeError(res, 400, 'Member invite requires an email address.', options.corsOrigin)
        return true
      }
      tools.writeJson(res, 201, {
        member: await options.service.inviteOrgMember(context.principal, { email, role }),
      }, options.corsOrigin)
      return true
    }
    if (action && input.artifactId === 'update' && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      tools.writeJson(res, 200, {
        member: await options.service.updateOrgMember(context.principal, action, {
          role: memberRole(body.role),
          status: memberStatus(body.status),
          confirm: tools.readString(body.confirm),
        }),
      }, options.corsOrigin)
      return true
    }
  }

  if (itemId === 'audit' && !action && req.method === 'GET') {
    tools.writeJson(res, 200, {
      events: await options.service.listAuditEvents(context.principal, {
        limit: tools.parseLimit(context.url),
      }),
    }, options.corsOrigin)
    return true
  }

  if (itemId === 'worker-pools') {
    if (!action && req.method === 'GET') {
      tools.writeJson(res, 200, {
        pools: await options.service.listManagedWorkerPools(context.principal, {
          status: poolStatus(context.url.searchParams.get('status')),
          limit: tools.parseLimit(context.url),
        }),
      }, options.corsOrigin)
      return true
    }
    if (!action && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const name = tools.readString(body.name)
      const mode = poolMode(body.mode)
      if (!name || !mode) {
        tools.writeError(res, 400, 'Managed worker pool requires name and supported mode.', options.corsOrigin)
        return true
      }
      tools.writeJson(res, 201, {
        pool: await options.service.createManagedWorkerPool(context.principal, {
          poolId: tools.readString(body.poolId) || undefined,
          name,
          mode,
          status: poolStatus(body.status) || undefined,
          region: tools.readString(body.region),
          capabilities: tools.readRecord(body.capabilities) || undefined,
          maxWorkers: nullableNumber(body.maxWorkers),
          maxConcurrentWork: nullableNumber(body.maxConcurrentWork),
        }),
      }, options.corsOrigin)
      return true
    }
    if (action && artifactId === 'update' && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const pool = await options.service.updateManagedWorkerPool(context.principal, action, {
        name: tools.readString(body.name) || undefined,
        status: poolStatus(body.status) || undefined,
        region: Object.prototype.hasOwnProperty.call(body, 'region') ? tools.readString(body.region) : undefined,
        capabilities: tools.readRecord(body.capabilities) || undefined,
        maxWorkers: Object.prototype.hasOwnProperty.call(body, 'maxWorkers') ? nullableNumber(body.maxWorkers) : undefined,
        maxConcurrentWork: Object.prototype.hasOwnProperty.call(body, 'maxConcurrentWork') ? nullableNumber(body.maxConcurrentWork) : undefined,
      })
      tools.writeJson(res, pool ? 200 : 404, { pool }, options.corsOrigin)
      return true
    }
  }

  if (itemId === 'workers') {
    if (!action && req.method === 'GET') {
      tools.writeJson(res, 200, {
        workers: await options.service.listManagedWorkers(context.principal, {
          poolId: context.url.searchParams.get('poolId'),
          status: workerStatus(context.url.searchParams.get('status')),
          limit: tools.parseLimit(context.url),
        }),
      }, options.corsOrigin)
      return true
    }
    if (!action && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const poolId = tools.readString(body.poolId)
      const displayName = tools.readString(body.displayName)
      if (!poolId || !displayName) {
        tools.writeError(res, 400, 'Managed worker registration requires poolId and displayName.', options.corsOrigin)
        return true
      }
      tools.writeJson(res, 201, {
        worker: await options.service.registerManagedWorker(context.principal, {
          workerId: tools.readString(body.workerId) || undefined,
          poolId,
          displayName,
          status: workerStatus(body.status) || undefined,
          version: tools.readString(body.version),
          capabilities: tools.readRecord(body.capabilities) || undefined,
        }),
      }, options.corsOrigin)
      return true
    }
    if (action && !artifactId && req.method === 'GET') {
      const worker = await options.service.getManagedWorker(context.principal, action)
      tools.writeJson(res, worker ? 200 : 404, { worker }, options.corsOrigin)
      return true
    }
    if (action && ['activate', 'pause', 'resume', 'drain', 'retire', 'revoke', 'unhealthy'].includes(String(artifactId)) && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const lifecycleStatus = artifactId === 'activate'
        ? 'active'
        : artifactId === 'resume'
          ? 'active'
          : artifactId === 'drain'
            ? 'draining'
            : artifactId === 'revoke'
              ? 'revoked'
              : artifactId
      const worker = await options.service.updateManagedWorkerLifecycle(context.principal, action, lifecycleStatus as ManagedWorkerStatus, {
        reason: tools.readString(body.reason),
      })
      tools.writeJson(res, worker ? 200 : 404, { worker }, options.corsOrigin)
      return true
    }
    if (action && artifactId === 'credentials' && !context.segments[5] && req.method === 'GET') {
      tools.writeJson(res, 200, {
        credentials: await options.service.listManagedWorkerCredentials(context.principal, action),
      }, options.corsOrigin)
      return true
    }
    if (action && artifactId === 'credentials' && !context.segments[5] && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      tools.writeJson(res, 201, {
        credential: await options.service.issueManagedWorkerCredential(context.principal, action, {
          scopes: tools.readStringArray(body.scopes),
          expiresAt: tools.readOptionalDate(body.expiresAt),
        }),
      }, options.corsOrigin)
      return true
    }
    if (action && artifactId === 'credentials' && context.segments[5] && context.segments[6] === 'rotate' && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      tools.writeJson(res, 201, {
        credential: await options.service.rotateManagedWorkerCredential(context.principal, action, context.segments[5], {
          expiresAt: tools.readOptionalDate(body.expiresAt),
        }),
      }, options.corsOrigin)
      return true
    }
    if (action && artifactId === 'credentials' && context.segments[5] && context.segments[6] === 'revoke' && req.method === 'POST') {
      const credential = await options.service.revokeManagedWorkerCredential(context.principal, action, context.segments[5])
      tools.writeJson(res, credential ? 200 : 404, { credential }, options.corsOrigin)
      return true
    }
    if (action && artifactId === 'heartbeats' && req.method === 'GET') {
      tools.writeJson(res, 200, {
        heartbeats: await options.service.listManagedWorkerHeartbeats(context.principal, {
          workerId: action,
          limit: tools.parseLimit(context.url),
        }),
      }, options.corsOrigin)
      return true
    }
  }

  tools.writeError(res, 404, 'Not found.', options.corsOrigin)
  return true
}

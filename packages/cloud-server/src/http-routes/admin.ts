import type { AuditActorType, ControlPlaneMembershipStatus, ControlPlaneRole, ManagedWorkerStatus } from '../control-plane-store.ts'
import { writeCorsHeaders } from '../http-response-writers.ts'
import type { AuditExportOptions, AuditQueryFilters } from '../services/audit-service.ts'
import type { CloudApiRouteInput } from './types.ts'

function auditActorType(value: unknown): AuditActorType | null {
  return value === 'user' || value === 'api_token' || value === 'system' ? value : null
}

function optionalIsoDate(value: string | null): Date | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function auditQueryFilters(url: URL): AuditQueryFilters {
  return {
    actorId: url.searchParams.get('actorId'),
    actorType: auditActorType(url.searchParams.get('actorType')),
    eventTypePrefix: url.searchParams.get('action'),
    targetType: url.searchParams.get('targetType'),
    targetId: url.searchParams.get('targetId'),
    result: url.searchParams.get('result'),
    from: optionalIsoDate(url.searchParams.get('from')),
    to: optionalIsoDate(url.searchParams.get('to')),
  }
}

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

  // The caller's own effective access (#896) — the Admin surface reads this to gate
  // every section/action. Open to any authenticated member: it only ever reflects
  // the requester's own resolved permission set.
  if (itemId === 'access' && !action && req.method === 'GET') {
    const principal = context.principal
    tools.writeJson(res, 200, {
      access: {
        role: principal.role ?? null,
        customRoleKey: principal.customRoleKey ?? null,
        permissions: principal.permissions ?? [],
        email: principal.email ?? null,
        ssoVerified: principal.ssoVerified ?? false,
      },
    }, options.corsOrigin)
    return true
  }

  // The assignable permission catalog custom-role editors render against (#896).
  if (itemId === 'permission-catalog' && !action && req.method === 'GET') {
    tools.writeJson(res, 200, {
      permissions: options.service.listPermissionCatalog(),
    }, options.corsOrigin)
    return true
  }

  // Custom-role CRUD (#896), gated on roles:manage inside the service layer.
  if (itemId === 'roles') {
    if (!action && req.method === 'GET') {
      tools.writeJson(res, 200, {
        roles: await options.service.listCustomRoles(context.principal),
      }, options.corsOrigin)
      return true
    }
    if (!action && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const roleKey = tools.readString(body.roleKey)
      const name = tools.readString(body.name)
      if (!roleKey || !name) {
        tools.writeError(res, 400, 'Custom role requires a roleKey and name.', options.corsOrigin)
        return true
      }
      tools.writeJson(res, 201, {
        role: await options.service.createCustomRole(context.principal, {
          roleKey,
          name,
          description: tools.readString(body.description),
          baseRole: memberRole(body.baseRole),
          permissions: tools.readStringArray(body.permissions) ?? [],
        }),
      }, options.corsOrigin)
      return true
    }
    if (action && artifactId === 'update' && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      tools.writeJson(res, 200, {
        role: await options.service.updateCustomRole(context.principal, action, {
          name: Object.prototype.hasOwnProperty.call(body, 'name') ? tools.readString(body.name) : undefined,
          description: Object.prototype.hasOwnProperty.call(body, 'description') ? tools.readString(body.description) : undefined,
          baseRole: Object.prototype.hasOwnProperty.call(body, 'baseRole') ? memberRole(body.baseRole) : undefined,
          permissions: Object.prototype.hasOwnProperty.call(body, 'permissions') ? (tools.readStringArray(body.permissions) ?? undefined) : undefined,
        }),
      }, options.corsOrigin)
      return true
    }
    if (action && !artifactId && req.method === 'DELETE') {
      tools.writeJson(res, 200, {
        deleted: await options.service.deleteCustomRole(context.principal, action),
      }, options.corsOrigin)
      return true
    }
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
      const invited = await options.service.inviteOrgMember(context.principal, { email, role })
      tools.writeJson(res, 201, {
        member: invited.member,
        inviteToken: invited.inviteToken,
        inviteExpiresAt: invited.inviteExpiresAt,
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
    // Assign or clear a member's custom role (#896), gated members:manage in the
    // service. Returns the fresh member record (its customRoleKey now updated).
    if (action && input.artifactId === 'role' && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const roleKey = body.roleKey === null ? null : tools.readString(body.roleKey)
      await options.service.assignMemberRole(context.principal, action, { roleKey })
      tools.writeJson(res, 200, {
        member: await options.service.updateOrgMember(context.principal, action, {}),
      }, options.corsOrigin)
      return true
    }
  }

  // Enterprise SSO config CRUD (#895), gated on sso:manage inside the service.
  if (itemId === 'sso') {
    if (!action && req.method === 'GET') {
      tools.writeJson(res, 200, { sso: await options.service.getSsoConfig(context.principal) }, options.corsOrigin)
      return true
    }
    if (!action && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const protocol = body.protocol === 'saml' || body.protocol === 'oidc' ? body.protocol : undefined
      tools.writeJson(res, 200, {
        sso: await options.service.upsertSsoConfig(context.principal, {
          protocol,
          enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
          enforced: typeof body.enforced === 'boolean' ? body.enforced : undefined,
          displayName: Object.prototype.hasOwnProperty.call(body, 'displayName') ? tools.readString(body.displayName) : undefined,
          verifiedDomains: tools.readStringArray(body.verifiedDomains) ?? undefined,
          oidcIssuer: Object.prototype.hasOwnProperty.call(body, 'oidcIssuer') ? tools.readString(body.oidcIssuer) : undefined,
          oidcClientId: Object.prototype.hasOwnProperty.call(body, 'oidcClientId') ? tools.readString(body.oidcClientId) : undefined,
          oidcClientSecret: Object.prototype.hasOwnProperty.call(body, 'oidcClientSecret') ? tools.readString(body.oidcClientSecret) : undefined,
          samlEntityId: Object.prototype.hasOwnProperty.call(body, 'samlEntityId') ? tools.readString(body.samlEntityId) : undefined,
          samlAcsUrl: Object.prototype.hasOwnProperty.call(body, 'samlAcsUrl') ? tools.readString(body.samlAcsUrl) : undefined,
          samlSloUrl: Object.prototype.hasOwnProperty.call(body, 'samlSloUrl') ? tools.readString(body.samlSloUrl) : undefined,
          samlIdpEntityId: Object.prototype.hasOwnProperty.call(body, 'samlIdpEntityId') ? tools.readString(body.samlIdpEntityId) : undefined,
          samlIdpSsoUrl: Object.prototype.hasOwnProperty.call(body, 'samlIdpSsoUrl') ? tools.readString(body.samlIdpSsoUrl) : undefined,
          samlIdpMetadataUrl: Object.prototype.hasOwnProperty.call(body, 'samlIdpMetadataUrl') ? tools.readString(body.samlIdpMetadataUrl) : undefined,
          samlIdpCertificate: Object.prototype.hasOwnProperty.call(body, 'samlIdpCertificate') ? tools.readString(body.samlIdpCertificate) : undefined,
          scimEnabled: typeof body.scimEnabled === 'boolean' ? body.scimEnabled : undefined,
        }),
      }, options.corsOrigin)
      return true
    }
    if (action === 'scim-token' && req.method === 'POST') {
      tools.writeJson(res, 201, await options.service.rotateScimToken(context.principal), options.corsOrigin)
      return true
    }
    if (!action && req.method === 'DELETE') {
      tools.writeJson(res, 200, { deleted: await options.service.deleteSsoConfig(context.principal) }, options.corsOrigin)
      return true
    }
  }

  if (itemId === 'audit' && !action && req.method === 'GET') {
    const page = await options.service.queryAuditEvents(context.principal, {
      ...auditQueryFilters(context.url),
      limit: tools.parseLimit(context.url),
      cursor: context.url.searchParams.get('cursor'),
    })
    tools.writeJson(res, 200, { events: page.events, nextCursor: page.nextCursor }, options.corsOrigin)
    return true
  }

  if (itemId === 'audit' && action === 'export' && req.method === 'GET') {
    const format = context.url.searchParams.get('format') === 'csv' ? 'csv' : 'json'
    const exportOptions: AuditExportOptions = {
      ...auditQueryFilters(context.url),
      format,
      unredacted: context.url.searchParams.get('unredacted') === 'true',
    }
    const stream = await options.service.exportAuditEvents(context.principal, exportOptions)
    writeCorsHeaders(res, options.corsOrigin)
    res.writeHead(200, {
      'content-type': stream.contentType,
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename="${stream.filename}"`,
    })
    for await (const chunk of stream.chunks) {
      if (!res.write(chunk)) {
        await new Promise<void>((resolve) => res.once('drain', () => resolve()))
      }
    }
    res.end()
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

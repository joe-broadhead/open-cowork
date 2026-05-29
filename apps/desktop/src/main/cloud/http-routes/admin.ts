import type { ControlPlaneMembershipStatus, ControlPlaneRole } from '../control-plane-store.ts'
import type { CloudApiRouteInput } from './types.ts'

function memberRole(value: unknown): ControlPlaneRole | null {
  return value === 'owner' || value === 'admin' || value === 'member' ? value : null
}

function memberStatus(value: unknown): ControlPlaneMembershipStatus | null {
  return value === 'active' || value === 'invited' || value === 'disabled' ? value : null
}

export async function handleAdminApiRoute(input: CloudApiRouteInput): Promise<boolean> {
  const { req, res, options, context, itemId, action, tools } = input

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

  tools.writeError(res, 404, 'Not found.', options.corsOrigin)
  return true
}

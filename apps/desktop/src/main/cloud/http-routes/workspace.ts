import type { CloudApiRouteInput } from './types.ts'

export async function handleWorkspaceApiRoute(input: CloudApiRouteInput): Promise<boolean> {
  const { req, res, options, context, resource, itemId, action, tools } = input

  if (resource === 'config' && req.method === 'GET') {
    tools.writeJson(res, 200, {
      role: options.policy.role,
      profileName: options.policy.profileName,
      features: options.policy.features,
      allowedAgents: options.policy.allowedAgents,
      allowedTools: options.policy.allowedTools,
      allowedMcps: options.policy.allowedMcps,
      publicBranding: options.publicBranding || null,
    }, options.corsOrigin)
    return true
  }

  if (resource === 'workspace' && !itemId && req.method === 'GET') {
    tools.writeJson(res, 200, await options.service.getWorkspaceOverview(context.principal), options.corsOrigin)
    return true
  }

  if (resource === 'events' && !itemId && req.method === 'GET') {
    await tools.handleWorkspaceSse(req, res, options, context)
    return true
  }

  if (resource === 'workers' && itemId === 'heartbeats' && !action && req.method === 'GET') {
    tools.writeJson(res, 200, {
      heartbeats: await options.service.listWorkerHeartbeats(context.principal),
    }, options.corsOrigin)
    return true
  }

  if (resource === 'runtime' && itemId === 'status' && !action && req.method === 'GET') {
    tools.writeJson(res, 200, {
      role: options.policy.role,
      profileName: options.policy.profileName,
      canExecute: Boolean(options.worker),
      commandProcessing: options.worker
        ? options.autoProcessCommands
          ? 'inline'
          : 'durable'
        : 'delegated',
      checkpoints: Boolean(options.worker),
      heartbeats: await options.service.listWorkerHeartbeats(context.principal),
    }, options.corsOrigin)
    return true
  }

  if (resource === 'usage' && itemId === 'events' && !action && req.method === 'GET') {
    tools.writeJson(res, 200, {
      events: await options.service.listUsageEvents(context.principal, tools.parseLimit(context.url)),
    }, options.corsOrigin)
    return true
  }

  return false
}

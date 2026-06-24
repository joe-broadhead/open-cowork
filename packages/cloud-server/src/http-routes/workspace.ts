import type { CloudApiRouteInput } from './types.ts'

function readNonNegativeInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

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

  if (resource === 'metrics' && !itemId && req.method === 'GET') {
    await options.service.listWorkerHeartbeats(context.principal)
    res.writeHead(200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(options.observability?.renderPrometheus?.() || '')
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

  if (resource === 'workers' && itemId && action === 'heartbeat' && req.method === 'POST') {
    const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    tools.writeJson(res, 200, {
      heartbeat: await options.service.recordManagedWorkerHeartbeat(context.principal, itemId, {
        version: tools.readString(body.version),
        capabilities: tools.readRecord(body.capabilities) || undefined,
        currentLoad: readNonNegativeInteger(body.currentLoad),
        activeWorkIds: tools.readStringArray(body.activeWorkIds) || undefined,
        lastErrorCode: tools.readString(body.lastErrorCode),
        lastErrorSummary: tools.readString(body.lastErrorSummary),
        heartbeatSequence: readNonNegativeInteger(body.heartbeatSequence) ?? null,
      }),
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

  if (resource === 'usage' && itemId === 'summary' && !action && req.method === 'GET') {
    tools.writeJson(res, 200, await options.service.getUsageSummary(context.principal, tools.parseLimit(context.url)), options.corsOrigin)
    return true
  }

  if (resource === 'diagnostics' && !itemId && !action && req.method === 'GET') {
    tools.writeJson(res, 200, await options.service.getDiagnosticsBundle(context.principal), options.corsOrigin)
    return true
  }

  return false
}

import type { RouteHandler } from '../daemon-router.js'
import { json } from '../daemon-router.js'
import { evaluateDaemonMutationFence, recordDaemonMutationDenied } from '../daemon-leadership.js'
import { channelRoutes } from './channels.js'
import { opencodeRoutes } from './opencode.js'
import { systemRoutes } from './system.js'
import { workRoutes } from './work.js'

export function createJsonRoutes(): RouteHandler[] {
  return [
    daemonLeadershipMutationGuard(),
    ...systemRoutes(),
    ...channelRoutes(),
    ...workRoutes(),
    ...opencodeRoutes(),
  ]
}

function daemonLeadershipMutationGuard(): RouteHandler {
  return async ({ req, url }) => {
    const decision = evaluateDaemonMutationFence({ method: req.method, pathname: url.pathname, component: 'http-route' })
    if (decision.allowed) return undefined
    recordDaemonMutationDenied({ method: req.method, pathname: url.pathname, source: 'http-route', actor: 'http' })
    return json({
      error: decision.error,
      required: 'daemon_writer',
      safeNextAction: decision.safeNextAction,
      leadership: decision.leadership,
    }, decision.status)
  }
}

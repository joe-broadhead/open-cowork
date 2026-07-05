import { isMcpAuthRequiredStatus } from '@open-cowork/shared'
import type { McpConnection } from '../stores/session'

export type McpStatusSummary = {
  total: number
  connected: McpConnection[]
  needsAuth: McpConnection[]
  failed: McpConnection[]
}

export function summarizeMcpConnections(connections: McpConnection[]): McpStatusSummary {
  const connected: McpConnection[] = []
  const needsAuth: McpConnection[] = []
  const failed: McpConnection[] = []

  for (const connection of connections) {
    if (connection.connected) connected.push(connection)
    else if (isMcpAuthRequiredStatus(connection.rawStatus)) needsAuth.push(connection)
    else failed.push(connection)
  }

  return {
    total: connections.length,
    connected,
    needsAuth,
    failed,
  }
}

export function mcpStatusTone(summary: McpStatusSummary) {
  if (summary.total === 0) return 'muted'
  if (summary.failed.length > 0) return 'error'
  if (summary.needsAuth.length > 0) return 'warning'
  return 'success'
}

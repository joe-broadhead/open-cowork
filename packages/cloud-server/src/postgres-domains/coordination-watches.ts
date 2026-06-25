import type { CoordinationWatch } from '@open-cowork/shared'
import { coerceCoordinationWatchChannel, coerceCoordinationWatchEvents } from '@open-cowork/shared'
import { iso, jsonRecord, type QueryRow } from './shared.ts'

export function coordinationWatchFromRow(row: QueryRow): CoordinationWatch {
  return {
    id: String(row.watch_id || ''),
    kind: 'watch',
    workspaceId: String(row.workspace_id || ''),
    ownerAuthority: 'cloud_channel_gateway',
    executionAuthority: 'cloud_channel_gateway',
    stateOwner: 'cloud_control_plane',
    target: {
      kind: String(row.target_kind || 'conversation') as CoordinationWatch['target']['kind'],
      id: String(row.target_id || ''),
    },
    events: coerceCoordinationWatchEvents(row.events),
    channel: coerceCoordinationWatchChannel(row.channel),
    recipient: row.recipient === null || row.recipient === undefined
      ? null
      : jsonRecord(row.recipient) as CoordinationWatch['recipient'],
    status: String(row.status || 'paused') as CoordinationWatch['status'],
    deliverySurface: String(row.delivery_surface || 'gateway_channel') as CoordinationWatch['deliverySurface'],
    verbosity: String(row.verbosity || 'normal') as CoordinationWatch['verbosity'],
    cursor: row.cursor === undefined ? null : row.cursor as CoordinationWatch['cursor'],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

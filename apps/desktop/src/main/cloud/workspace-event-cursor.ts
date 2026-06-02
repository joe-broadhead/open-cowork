type Sequenced = { sequence: number }

export type WorkspaceEventCursorRecord = {
  earliestSequence: number | null
  latestSequence: number
}

export function workspaceEventCursor(events: readonly Sequenced[]): WorkspaceEventCursorRecord {
  return {
    earliestSequence: events[0]?.sequence ?? null,
    latestSequence: events.at(-1)?.sequence || 0,
  }
}

export function workspaceEventCursorFromRow(row: Record<string, unknown> | undefined): WorkspaceEventCursorRecord {
  return {
    earliestSequence: row?.earliest_sequence === null || row?.earliest_sequence === undefined ? null : Number(row.earliest_sequence),
    latestSequence: row?.latest_sequence === null || row?.latest_sequence === undefined ? 0 : Number(row.latest_sequence),
  }
}

import { describe, expect, it } from 'vitest'
import { parseGatewaySessionRows } from '../mission-data.js'

describe('parseGatewaySessionRows', () => {
  it('keeps well-formed rows and preserves link fields via loose parsing', () => {
    const rows = parseGatewaySessionRows([
      { id: 'ses_1', title: 'GW:Task', directory: '/work/project', cost: 0.5, tokens: { input: 10 } },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'ses_1', title: 'GW:Task', directory: '/work/project' })
  })

  it('drops malformed rows (renamed/absent required id) instead of blanking them through', () => {
    const rows = parseGatewaySessionRows([
      { id: 'ses_ok', title: 'GW:Keep' },
      { sessionId: 'ses_renamed_id', title: 'GW:Dropped' }, // `id` renamed upstream -> invalid
      { title: 'GW:NoId' }, // missing id entirely
      { id: 42, title: 'GW:NumericId' }, // wrong id type
      'not-an-object',
      null,
    ])
    expect(rows.map(row => row.id)).toEqual(['ses_ok'])
  })

  it('returns an empty array for non-array payloads', () => {
    expect(parseGatewaySessionRows(null)).toEqual([])
    expect(parseGatewaySessionRows({ sessions: [] })).toEqual([])
    expect(parseGatewaySessionRows(undefined)).toEqual([])
  })
})

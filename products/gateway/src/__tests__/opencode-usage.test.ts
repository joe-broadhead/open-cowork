import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { buildUsageWindow, getOpenCodeUsage } from '../opencode-usage.js'

describe('OpenCode usage', () => {
  it('aggregates message-level token and cost data for today', () => {
    const dbPath = createUsageDb()
    const now = new Date(2026, 5, 13, 12)
    const usage = getOpenCodeUsage({
      dbPath,
      opencodeUrl: 'http://127.0.0.1:4096',
      window: buildUsageWindow(new URLSearchParams('range=today'), now),
    })

    expect(usage.available).toBe(true)
    expect(usage.window.label).toBe('Today')
    expect(usage.totals.sessions).toBe(1)
    expect(usage.totals.messages).toBe(1)
    expect(usage.totals.cost).toBeCloseTo(0.25)
    expect(usage.totals.input).toBe(100)
    expect(usage.totals.output).toBe(50)
    expect(usage.totals.reasoning).toBe(10)
    expect(usage.totals.cacheRead).toBe(40)
    expect(usage.totals.cacheWrite).toBe(5)
    expect(usage.totals.tokenBurn).toBe(205)
    expect(usage.totals.cacheHitRate).toBeCloseTo(40 / 140)
    expect(usage.series).toEqual([{ date: '2026-06-13', cost: 0.25, tokens: 205, sessions: 1 }])
    expect(usage.byModel[0]!.label).toBe('openrouter/test-model')
    expect(usage.byAgent[0]!.label).toBe('build')
    expect(usage.topSessions[0]!.webUrl).toContain('/session/ses_today')
  })

  it('treats custom end dates as inclusive', () => {
    const dbPath = createUsageDb()
    const usage = getOpenCodeUsage({
      dbPath,
      window: buildUsageWindow(new URLSearchParams('range=custom&from=2026-06-12&to=2026-06-13'), new Date(2026, 5, 13, 12)),
    })

    expect(usage.window.preset).toBe('custom')
    expect(usage.totals.sessions).toBe(2)
    expect(usage.totals.cost).toBeCloseTo(0.35)
    expect(usage.totals.tokenBurn).toBe(235)
    expect(usage.series.map(point => point.date)).toEqual(['2026-06-12', '2026-06-13'])
    expect(usage.series.map(point => point.sessions)).toEqual([1, 1])
  })

  it('shows today as the display end date for rolling windows', () => {
    const usageWindow = buildUsageWindow(new URLSearchParams('range=last7'), new Date(2026, 5, 13, 12))

    expect(usageWindow.startDate).toBe('2026-06-06')
    expect(usageWindow.endDate).toBe('2026-06-13')
  })

  it('ignores date inputs unless the custom range is selected', () => {
    const usageWindow = buildUsageWindow(new URLSearchParams('range=last7&from=2026-06-13&to=2026-06-13'), new Date(2026, 5, 13, 12))

    expect(usageWindow.preset).toBe('last7')
    expect(usageWindow.startDate).toBe('2026-06-06')
    expect(usageWindow.endDate).toBe('2026-06-13')
  })
})

function createUsageDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-usage-test-'))
  const dbPath = path.join(dir, 'opencode.db')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      create table session (
        id text primary key,
        title text,
        agent text,
        model text,
        directory text,
        path text,
        time_created integer,
        time_updated integer
      );
      create table message (
        id text primary key,
        session_id text,
        time_created integer,
        data text
      );
    `)
    insertSession(db, 'ses_today', 'Today session', 'build', 'openrouter/test-model', new Date(2026, 5, 13, 8).getTime())
    insertSession(db, 'ses_yesterday', 'Yesterday session', 'review', 'openrouter/other-model', new Date(2026, 5, 12, 8).getTime())
    insertMessage(db, 'msg_today', 'ses_today', new Date(2026, 5, 13, 9).getTime(), 0.25, 100, 50, 10, 40, 5, 'build', 'test-model')
    insertMessage(db, 'msg_yesterday', 'ses_yesterday', new Date(2026, 5, 12, 9).getTime(), 0.10, 20, 10, 0, 0, 0, 'review', 'other-model')
    return dbPath
  } finally {
    db.close()
  }
}

function insertSession(db: DatabaseSync, id: string, title: string, agent: string, model: string, time: number): void {
  db.prepare('insert into session (id, title, agent, model, directory, path, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, title, agent, model, '/tmp/project', '', time, time)
}

function insertMessage(db: DatabaseSync, id: string, sessionId: string, time: number, cost: number, input: number, output: number, reasoning: number, cacheRead: number, cacheWrite: number, agent: string, modelID: string): void {
  db.prepare('insert into message (id, session_id, time_created, data) values (?, ?, ?, ?)')
    .run(id, sessionId, time, JSON.stringify({
      cost,
      agent,
      providerID: 'openrouter',
      modelID,
      tokens: { input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } },
    }))
}

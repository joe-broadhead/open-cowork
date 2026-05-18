import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const serverEntry = resolve(packageRoot, 'dist/index.js')

async function withClockClient<T>(fn: (client: Client) => Promise<T>) {
  const client = new Client({ name: 'clock-contract-test', version: '1.0.0' }, { capabilities: {} })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    stderr: 'pipe',
  })

  await client.connect(transport)
  try {
    return await fn(client)
  } finally {
    await client.close().catch(() => {})
  }
}

function parseTextResult(result: Awaited<ReturnType<Client['callTool']>>) {
  assert.equal('isError' in result ? result.isError : false, false)
  assert.ok('content' in result, 'expected MCP tool result content')
  const [first] = result.content
  assert.equal(first?.type, 'text')
  assert.equal(typeof first.text, 'string')
  return JSON.parse(first.text) as Record<string, unknown>
}

test('clock MCP lists and executes every read-only tool over stdio', async () => {
  await withClockClient(async (client) => {
    const listed = await client.listTools()
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      'convert_time',
      'current_time',
      'date_math',
      'date_range',
      'duration_between',
    ])

    const current = parseTextResult(await client.callTool({
      name: 'current_time',
      arguments: { timezone: 'Europe/London' },
    }))
    assert.equal(current.kind, 'current_time')
    assert.equal((current.now as { timezone?: string }).timezone, 'Europe/London')

    const converted = parseTextResult(await client.callTool({
      name: 'convert_time',
      arguments: {
        time: '2026-05-14T12:00:00.000Z',
        to_timezone: 'America/New_York',
      },
    }))
    assert.equal((converted.target as { localDateTime?: string }).localDateTime, '2026-05-14T08:00:00')

    const math = parseTextResult(await client.callTool({
      name: 'date_math',
      arguments: {
        time: '2026-01-31T09:00:00',
        timezone: 'UTC',
        months: 1,
      },
    }))
    assert.equal((math.result as { localDateTime?: string }).localDateTime, '2026-02-28T09:00:00')

    const range = parseTextResult(await client.callTool({
      name: 'date_range',
      arguments: {
        range: 'last_week',
        timezone: 'Europe/Amsterdam',
        anchor: '2026-05-14T10:00:00.387Z',
        week_starts_on: 'monday',
      },
    }))
    assert.equal((range.startInclusive as { localDate?: string }).localDate, '2026-05-04')
    assert.equal((range.endExclusive as { localDate?: string }).localDate, '2026-05-11')
    assert.equal((range.anchor as { offset?: string }).offset, '+02:00')
    assert.equal(range.calendarDays, 7)

    const defaultSundayRange = parseTextResult(await client.callTool({
      name: 'date_range',
      arguments: {
        range: 'last_week',
        timezone: 'UTC',
        anchor: '2026-05-14T10:00:00.000Z',
      },
    }))
    assert.equal(defaultSundayRange.weekStartsOn, 'sunday')
    assert.equal((defaultSundayRange.startInclusive as { localDate?: string }).localDate, '2026-05-03')
    assert.equal((defaultSundayRange.endExclusive as { localDate?: string }).localDate, '2026-05-10')

    const duration = parseTextResult(await client.callTool({
      name: 'duration_between',
      arguments: {
        start: '2026-05-14T09:00:00.000Z',
        end: '2026-05-15T10:30:00.000Z',
        calendar_timezone: 'UTC',
      },
    }))
    assert.equal(duration.hours, 25.5)
    assert.equal(duration.calendarDays, 1)
  })
})

test('clock MCP rejects ambiguous local datetimes without timezone', async () => {
  await withClockClient(async (client) => {
    const result = await client.callTool({
      name: 'convert_time',
      arguments: {
        time: '2026-05-14T12:00:00',
        to_timezone: 'UTC',
      },
    })
    assert.equal('isError' in result ? result.isError : false, true)
    assert.match(JSON.stringify(result), /requires a timezone/)
  })
})

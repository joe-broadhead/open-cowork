import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { taskCommand } from '../cli/commands/task.js'
import { clearConfigCacheForTest } from '../config.js'

describe('task CLI command', () => {
  let originalArgv: string[]
  let testDir: string
  let logs: string[]

  beforeEach(() => {
    originalArgv = [...process.argv]
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-task-cli-'))
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_HTTP_PORT'] = '45678'
    clearConfigCacheForTest()
    logs = []
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => { logs.push(String(line ?? '')) })
  })

  afterEach(() => {
    process.argv = originalArgv
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['OPENCODE_GATEWAY_HTTP_PORT']
    vi.restoreAllMocks()
    clearConfigCacheForTest()
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('lists tasks through the daemon by default', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      counts: { pending: 1, running: 0, done: 0, blocked: 0, paused: 0 },
      tasks: [{ id: 'task_cli', status: 'pending', priority: 'HIGH', title: 'Daemon listed task', currentStage: 'implement' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    process.argv = ['node', 'cli.js', 'task', 'list']

    await taskCommand()

    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:45678/tasks', expect.objectContaining({ headers: {} }))
    expect(logs.join('\n')).toContain('1 pending | 0 running | 0 done | 0 blocked | 0 paused')
    expect(logs.join('\n')).toContain('- [pending] HIGH: Daemon listed task')
  })
})

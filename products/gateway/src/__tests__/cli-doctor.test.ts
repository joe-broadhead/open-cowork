import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

describe('doctor CLI', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-doctor-cli-'))
    fs.writeFileSync(path.join(testDir, 'config.json'), JSON.stringify({}, null, 2))
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('prints the local readiness catalog summary with actionable redacted entries', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'doctor'], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        OPENCODE_GATEWAY_CONFIG_DIR: testDir,
        OPENCODE_GATEWAY_STATE_DIR: testDir,
        TELEGRAM_BOT_TOKEN: '',
        WHATSAPP_ACCESS_TOKEN: '',
      },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Local readiness catalog:')
    expect(result.stdout).toMatch(/supported:\d+, partial:\d+, waived:\d+, blocked:\d+, unknown:\d+/)
    expect(result.stdout).toContain('runtime:opencode: opencode_health_not_probed')
    expect(result.stdout).toContain('setup:daemon_heartbeat: heartbeat_not_probed')
    expect(result.stdout).not.toContain('Bearer ')
    expect(result.stdout).not.toContain(testDir)
  })
})

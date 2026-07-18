import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readGatewayLogLines, readJournaldLogLines, rotateServiceLogIfNeeded } from '../service-logs.js'

describe('service logs', () => {
  it('redacts fallback log lines read directly from service log files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-service-logs-'))
    const file = path.join(dir, 'opencode-gateway.log')
    const telegram = '123456:abcdefghijklmnopqrstuvwxyz'
    const bearer = 'Bearer abcdefghijklmnopqrstuvwxyz'
    fs.writeFileSync(file, [
      `telegram failed token=${telegram}`,
      `opencode auth ${bearer}`,
      'plain event',
    ].join('\n'))

    const lines = readGatewayLogLines(10, { files: [file], config: { channels: { telegram: { botToken: telegram }, whatsapp: {} } } as any })
    const text = lines.join('\n')

    expect(text).not.toContain(telegram)
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(text).toContain('token=<redacted>')
    expect(text).toContain('Bearer <redacted>')
    expect(text).toContain('plain event')
  })

  it('rotates the service log with copy-truncate once it reaches the size cap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-log-rotation-'))
    const file = path.join(dir, 'opencode-gateway.log')

    // Missing or small files are left alone.
    expect(rotateServiceLogIfNeeded({ file, maxBytes: 100 })).toMatchObject({ rotated: false, size: 0 })
    fs.writeFileSync(file, 'short line\n')
    expect(rotateServiceLogIfNeeded({ file, maxBytes: 100 })).toMatchObject({ rotated: false })
    expect(fs.existsSync(`${file}.1`)).toBe(false)

    // Oversized log rotates: contents move to .1, live file is truncated in
    // place (same inode) so supervisor-held append descriptors keep working.
    fs.writeFileSync(file, 'x'.repeat(200))
    const inodeBefore = fs.statSync(file).ino
    expect(rotateServiceLogIfNeeded({ file, maxBytes: 100, keep: 2 })).toMatchObject({ rotated: true, size: 200 })
    expect(fs.statSync(file).size).toBe(0)
    expect(fs.statSync(file).ino).toBe(inodeBefore)
    expect(fs.readFileSync(`${file}.1`, 'utf-8')).toBe('x'.repeat(200))

    // A second rotation shifts .1 -> .2 and keep bounds the retained files.
    fs.writeFileSync(file, 'y'.repeat(200))
    expect(rotateServiceLogIfNeeded({ file, maxBytes: 100, keep: 2 }).rotated).toBe(true)
    expect(fs.readFileSync(`${file}.1`, 'utf-8')).toBe('y'.repeat(200))
    expect(fs.readFileSync(`${file}.2`, 'utf-8')).toBe('x'.repeat(200))

    fs.writeFileSync(file, 'z'.repeat(200))
    expect(rotateServiceLogIfNeeded({ file, maxBytes: 100, keep: 2 }).rotated).toBe(true)
    expect(fs.readFileSync(`${file}.2`, 'utf-8')).toBe('y'.repeat(200))
    expect(fs.existsSync(`${file}.3`)).toBe(false)

    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reads journald lines when available and reports unavailability for fallback', () => {
    const calls: Array<{ command: string; args: string[]; options?: { timeoutMs?: number; maxBuffer?: number } }> = []
    const ok = readJournaldLogLines(3, {
      runner: (command, args, options) => {
        calls.push({ command, args, options })
        return { status: 0, stdout: 'one\ntwo\nthree\n', stderr: '' }
      },
    })
    expect(ok).toEqual(['one', 'two', 'three'])
    // The read is bounded so a wedged journald cannot hang the daemon's /logs route.
    expect(calls[0]).toMatchObject({ command: 'journalctl', options: { timeoutMs: 2000 } })
    expect(calls[0]!.options?.maxBuffer).toBeGreaterThan(0)

    expect(readJournaldLogLines(3, { runner: () => ({ status: 1, stdout: '', stderr: 'No journal files' }) })).toBeUndefined()
    // Spawn failures and timeouts surface as status null through the shared runner.
    expect(readJournaldLogLines(3, { runner: () => ({ status: null, stdout: '', stderr: 'spawn journalctl ENOENT' }) })).toBeUndefined()
    expect(readJournaldLogLines(3, { runner: () => ({ status: 0, stdout: '', stderr: '' }) })).toBeUndefined()
  })
})

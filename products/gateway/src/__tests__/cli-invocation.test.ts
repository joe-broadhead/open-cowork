import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCliHelpText, buildGatewayAuthHeaders, buildSubcommandHelpText, buildUnknownCommandText, resolveCliDaemonToken, resolveCliInvocation } from '../cli.js'

const argv = (...args: string[]) => ['node', 'cli.js', ...args]

describe('resolveCliInvocation', () => {
  it('treats bare invocation and help as full help', () => {
    expect(resolveCliInvocation(argv())).toEqual({ kind: 'help' })
    expect(resolveCliInvocation(argv('help'))).toEqual({ kind: 'help' })
    expect(resolveCliInvocation(argv('--help'))).toEqual({ kind: 'help' })
    expect(resolveCliInvocation(argv('-h'))).toEqual({ kind: 'help' })
  })

  it('resolves --version and -v', () => {
    expect(resolveCliInvocation(argv('--version'))).toEqual({ kind: 'version' })
    expect(resolveCliInvocation(argv('-v'))).toEqual({ kind: 'version' })
  })

  it('runs known commands', () => {
    expect(resolveCliInvocation(argv('status'))).toEqual({ kind: 'run', command: 'status' })
    expect(resolveCliInvocation(argv('task', 'list'))).toEqual({ kind: 'run', command: 'task' })
  })

  it('routes a known command with --help to subcommand help', () => {
    expect(resolveCliInvocation(argv('task', '--help'))).toEqual({ kind: 'subcommand-help', command: 'task' })
    expect(resolveCliInvocation(argv('backup', 'list', '-h'))).toEqual({ kind: 'subcommand-help', command: 'backup' })
  })

  it('flags an unrecognized command', () => {
    expect(resolveCliInvocation(argv('taks'))).toEqual({ kind: 'unknown', command: 'taks' })
    expect(resolveCliInvocation(argv('nope'))).toEqual({ kind: 'unknown', command: 'nope' })
  })
})

describe('CLI help text', () => {
  it('separates COMMON and ADVANCED sections', () => {
    const help = buildCliHelpText()
    expect(help).toContain('COMMON commands:')
    expect(help).toContain('ADVANCED / diagnostics:')
    expect(help).toMatch(/OpenCode Gateway v\d/)
    // A daily driver and a diagnostic command both appear.
    expect(help).toContain('start')
    expect(help).toContain('backend')
  })

  it('renders per-subcommand flag help', () => {
    expect(buildSubcommandHelpText('readiness')).toContain('--strict')
    expect(buildSubcommandHelpText('logs')).toContain('--lines')
  })

  it('gives an unknown-command hint', () => {
    expect(buildUnknownCommandText('taks')).toContain('Unknown command: taks')
    expect(buildUnknownCommandText('taks')).toContain('opencode-gateway help')
  })
})

describe('CLI daemon token resolution', () => {
  it('returns undefined when no token env var is set (default: no header)', () => {
    expect(resolveCliDaemonToken({})).toBeUndefined()
    expect(resolveCliDaemonToken({ OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN: '   ' })).toBeUndefined()
  })

  it('reads the admin token and trims surrounding whitespace', () => {
    expect(resolveCliDaemonToken({ OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN: '  secret-admin  ' })).toBe('secret-admin')
  })

  it('reads an explicit admin token file reference', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-cli-token-'))
    const tokenFile = path.join(dir, 'admin-token')
    fs.writeFileSync(tokenFile, 'token-from-file\n')
    expect(resolveCliDaemonToken({ OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN_FILE: tokenFile })).toBe('token-from-file')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('CLI daemon auth header attach', () => {
  it('emits no header when the token is absent (unchanged loopback flow)', () => {
    expect(buildGatewayAuthHeaders(undefined)).toEqual({})
    expect(buildGatewayAuthHeaders('')).toEqual({})
  })

  it('attaches a bearer header when a token is resolved', () => {
    expect(buildGatewayAuthHeaders('secret-admin')).toEqual({ Authorization: 'Bearer secret-admin' })
  })
})

describe('direct CLI subprocess execution', () => {
  function runCli(...args: string[]) {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-cli-direct-'))
    fs.writeFileSync(path.join(configDir, 'config.json'), '{}')
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-cli-state-'))
    return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: path.resolve(__dirname, '../..'),
      env: {
        ...process.env,
        OPENCODE_GATEWAY_CONFIG_DIR: configDir,
        OPENCODE_GATEWAY_STATE_DIR: stateDir,
        OPENCODE_GATEWAY_HTTP_PORT: '65534',
      },
      encoding: 'utf8',
      timeout: 60_000,
    })
  }

  it('handles offline readiness and health without top-level initialization errors', () => {
    const readiness = runCli('readiness', '--json', '--strict')
    expect(readiness.status).toBe(1)
    expect(readiness.stderr).not.toContain('capabilityLoopbackWarned')
    expect(readiness.stdout).toContain('"state": "not_ready"')
    expect(readiness.stdout).toContain('Gateway daemon unreachable')

    const health = runCli('health', '--json')
    expect(health.status).toBe(1)
    expect(health.stderr).not.toContain('capabilityLoopbackWarned')
    expect(health.stdout).toContain('"status": "down"')
    expect(health.stdout).toContain('Gateway daemon is unreachable')
  })

  it.each([
    [['operator', 'unknown'], 'operator'],
    [['operator', 'run', 'run_1'], 'operator run'],
    [['project', 'new', 'demo', '--title'], 'project new'],
    [['backup', 'verify'], 'backup'],
    [['backup', 'create', '--retention', 'zero'], 'backup'],
    [['restore', '--from'], 'restore'],
    [['readiness', '--unknown'], 'readiness'],
    [['health', '--json', '--json'], 'health'],
    [['doctor', '--json'], 'doctor'],
  ] as const)('exits 2 for malformed %s invocation', (args, usageFragment) => {
    const result = runCli(...args)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Usage: opencode-gateway')
    expect(result.stderr).toContain(usageFragment)
  })
})

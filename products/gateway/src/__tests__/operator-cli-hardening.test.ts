import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const sharedMocks = vi.hoisted(() => ({
  fetchGatewayJson: vi.fn(),
  gatewayFetch: vi.fn(),
  postGatewayJson: vi.fn(),
}))
const operatorMocks = vi.hoisted(() => ({
  applyOperatorSafetyAction: vi.fn(),
  applyOperatorActiveRunControl: vi.fn(),
  buildOperatorSafetyReport: vi.fn(),
}))
const hygieneMocks = vi.hoisted(() => ({
  buildLiveStateHygieneReport: vi.fn(),
}))
const productMocks = vi.hoisted(() => ({
  buildProjectWizardBody: vi.fn(),
  createProjectFromWizard: vi.fn(),
}))

vi.mock('../cli/shared.js', async () => {
  const actual = await vi.importActual<typeof import('../cli/shared.js')>('../cli/shared.js')
  return {
    ...actual,
    assertConfigured: vi.fn(),
    fetchGatewayJson: sharedMocks.fetchGatewayJson,
    gatewayFetch: sharedMocks.gatewayFetch,
    postGatewayJson: sharedMocks.postGatewayJson,
  }
})

vi.mock('../operator-safety.js', () => ({
  ...operatorMocks,
  formatOperatorSafetyText: () => 'operator report',
}))

vi.mock('../live-state-hygiene.js', () => ({
  ...hygieneMocks,
  formatLiveStateHygieneText: () => 'hygiene report',
}))

vi.mock('../product-onboarding.js', () => productMocks)

import { GatewayHttpError, GatewayTransportError } from '../cli/shared.js'
import { readiness } from '../cli/commands/health.js'
import { operatorCommand } from '../cli/commands/operator.js'
import { projectCommand } from '../cli/commands/project.js'

const originalArgv = process.argv

beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  process.exitCode = undefined
  process.argv = ['node', 'opencode-gateway', 'operator', 'pause']
  operatorMocks.applyOperatorSafetyAction.mockResolvedValue({
    action: 'pause',
    applied: true,
    report: {},
  })
  operatorMocks.buildOperatorSafetyReport.mockResolvedValue({})
  hygieneMocks.buildLiveStateHygieneReport.mockResolvedValue({})
  productMocks.buildProjectWizardBody.mockImplementation(input => ({ ...input }))
  productMocks.createProjectFromWizard.mockReturnValue({ text: 'local project' })
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterAll(() => {
  process.argv = originalArgv
  vi.restoreAllMocks()
})

describe('operator CLI daemon authority', () => {
  it.each([400, 403, 409, 422])('never falls back to local mutation after HTTP %s', async status => {
    process.argv.push('--local')
    sharedMocks.postGatewayJson.mockRejectedValue(new GatewayHttpError(status, { error: `HTTP ${status}` }, `HTTP ${status}`))

    await expect(operatorCommand()).rejects.toMatchObject({ name: 'GatewayHttpError', status })
    expect(operatorMocks.applyOperatorSafetyAction).not.toHaveBeenCalled()
  })

  it('does not mutate locally for a transport failure without --local', async () => {
    sharedMocks.postGatewayJson.mockRejectedValue(new GatewayTransportError('connection refused'))

    await expect(operatorCommand()).rejects.toThrow('No local mutation was attempted')
    expect(operatorMocks.applyOperatorSafetyAction).not.toHaveBeenCalled()
  })

  it('allows local mutation only for a transport failure with --local', async () => {
    process.argv.push('--local')
    sharedMocks.postGatewayJson.mockRejectedValue(new GatewayTransportError('connection refused'))

    await operatorCommand()

    expect(operatorMocks.applyOperatorSafetyAction).toHaveBeenCalledWith('pause')
  })

  it('does not replace an HTTP status error with a local status report', async () => {
    process.argv = ['node', 'opencode-gateway', 'operator', 'status']
    sharedMocks.fetchGatewayJson.mockRejectedValue(new GatewayHttpError(403, { error: 'forbidden' }, 'forbidden'))

    await expect(operatorCommand()).rejects.toMatchObject({ name: 'GatewayHttpError', status: 403 })
    expect(operatorMocks.buildOperatorSafetyReport).not.toHaveBeenCalled()
  })
})

describe('project CLI daemon authority', () => {
  beforeEach(() => {
    process.argv = ['node', 'opencode-gateway', 'project', 'new', 'demo', '--title', 'Demo', '--session-id', 'ses_1']
  })

  it.each([400, 403, 409, 422])('never falls back to local mutation after HTTP %s', async status => {
    process.argv.push('--local')
    sharedMocks.postGatewayJson.mockRejectedValue(new GatewayHttpError(status, { error: `HTTP ${status}` }, `HTTP ${status}`))

    await expect(projectCommand()).rejects.toMatchObject({ name: 'GatewayHttpError', status })
    expect(productMocks.createProjectFromWizard).not.toHaveBeenCalled()
  })

  it('requires --local before transport failure can create local state', async () => {
    sharedMocks.postGatewayJson.mockRejectedValue(new GatewayTransportError('connection refused'))

    await expect(projectCommand()).rejects.toThrow('No local mutation was attempted')
    expect(productMocks.createProjectFromWizard).not.toHaveBeenCalled()

    process.argv.push('--local')
    await projectCommand()
    expect(productMocks.createProjectFromWizard).toHaveBeenCalledOnce()
  })
})

describe('readiness CLI status handling', () => {
  it('prints a structured not_ready 503 and exits nonzero in strict JSON mode', async () => {
    process.argv = ['node', 'opencode-gateway', 'readiness', '--json', '--strict']
    sharedMocks.gatewayFetch.mockResolvedValue(new Response(JSON.stringify({
      state: 'not_ready',
      summary: 'OpenCode unavailable',
      checks: [],
    }), { status: 503, headers: { 'content-type': 'application/json' } }))
    const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      process.exitCode = Number(code)
      return undefined as never
    })

    await readiness()

    expect(exit).toHaveBeenCalledWith(1)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"state": "not_ready"'))
    exit.mockRestore()
  })

  it('fails closed when a successful readiness response does not match the runtime schema', async () => {
    process.argv = ['node', 'opencode-gateway', 'readiness', '--json']
    sharedMocks.gatewayFetch.mockResolvedValue(new Response(JSON.stringify({ state: 'ready' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      process.exitCode = Number(code)
      return undefined as never
    })

    await readiness()

    expect(exit).toHaveBeenCalledWith(1)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('invalid readiness response'))
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"state": "not_ready"'))
    exit.mockRestore()
  })
})

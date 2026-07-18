import { describe, expect, it } from 'vitest'
import { LOCAL_SESSION_LINK_SECURITY_BOUNDARY, dirBase64, formatOpenCodeSessionLinks, formatOpenCodeUnavailableSessionLinks, gatewayLocalBaseUrl, opencodeSessionLinks, opencodeSessionTuiCommand, opencodeSessionWebUrl, unavailableOpenCodeSessionLinks } from '../opencode-web.js'

describe('opencode web links', () => {
  it('uses OpenCode dirBase64 routes instead of raw filesystem paths', () => {
    const directory = '/tmp/example-project'
    expect(opencodeSessionWebUrl('http://localhost:4096', { id: 'ses_1', directory }))
      .toBe(`http://localhost:4096/${dirBase64(directory)}/session/ses_1`)
  })

  it('falls back from OpenCode path metadata to an absolute directory', () => {
    expect(opencodeSessionWebUrl('http://localhost:4096/', { id: 'ses 1', path: 'tmp/example project' }))
      .toBe(`http://localhost:4096/${dirBase64('/tmp/example project')}/session/ses%201`)
  })

  it('emits Web and TUI links for a resumable session', () => {
    const links = opencodeSessionLinks('http://localhost:4096/', { id: 'ses_1', directory: '/tmp/example-project' })

    expect(links).toMatchObject({
      sessionId: 'ses_1',
      webUrl: `http://localhost:4096/${dirBase64('/tmp/example-project')}/session/ses_1`,
      webStatus: 'metadata_only',
      securityBoundary: LOCAL_SESSION_LINK_SECURITY_BOUNDARY,
      tuiCommand: 'opencode /tmp/example-project --session ses_1',
      directory: '/tmp/example-project',
      missionControlUrl: 'http://127.0.0.1:4097/dashboard',
      sessionEvidenceUrl: 'http://127.0.0.1:4097/opencode/sessions/ses_1',
      operatorJourney: {
        surface: 'opencode_web_tui',
        channelCapability: 'partial',
        proofState: 'partial',
        recoveryPath: expect.objectContaining({ state: 'fallback' }),
      },
    })
    const text = formatOpenCodeSessionLinks('http://localhost:4096/', { id: 'ses_1', directory: '/tmp/example-project' })
    expect(text).toContain('OpenCode TUI: opencode /tmp/example-project --session ses_1')
    expect(text).toContain('Web recovery: if Web says the session was not found')
    expect(text).toContain(`Security: ${LOCAL_SESSION_LINK_SECURITY_BOUNDARY}`)
    expect(text).toContain('Operator journey: Open or recover OpenCode Session: partial')
    expect(text).toContain('Session evidence: http://127.0.0.1:4097/opencode/sessions/ses_1')
  })

  it('falls back gracefully when Web route metadata is unavailable', () => {
    expect(opencodeSessionWebUrl('http://localhost:4096/', { id: 'ses_1' })).toBe('')
    expect(opencodeSessionTuiCommand({ id: 'ses 1' })).toBe("opencode --session 'ses 1'")
    expect(formatOpenCodeSessionLinks('http://localhost:4096/', { id: 'ses_1' })).toBe([
      'OpenCode Web: unavailable (session metadata missing directory/path)',
      'Web recovery: use the TUI command or Mission Control evidence below; Web deep links need session directory metadata.',
      `Security: ${LOCAL_SESSION_LINK_SECURITY_BOUNDARY}`,
      'Operator journey: Recover OpenCode Session link: fallback; wait=operator; permission=not_required; proof=missing; next=use the TUI command or Mission Control evidence below; Web deep links need session directory metadata.',
      'OpenCode TUI: opencode --session ses_1',
      'Mission Control: http://127.0.0.1:4097/dashboard',
      'Session evidence: http://127.0.0.1:4097/opencode/sessions/ses_1',
    ].join('\n'))
  })

  it('uses configured local Gateway ports for Mission Control evidence links', () => {
    expect(gatewayLocalBaseUrl(5100, '0.0.0.0')).toBe('http://127.0.0.1:5100')
    expect(formatOpenCodeSessionLinks('http://localhost:4096/', { id: 'ses_custom', directory: '/tmp/custom' }, { gatewayBaseUrl: 'http://127.0.0.1:5100/' }))
      .toContain('Session evidence: http://127.0.0.1:5100/opencode/sessions/ses_custom')
  })

  it('formats unavailable sessions without emitting stale Web deep links', () => {
    const links = unavailableOpenCodeSessionLinks('ses_missing', {
      gatewayBaseUrl: 'http://127.0.0.1:5100/',
      reason: 'session not found in OpenCode API',
      actionHint: 'Run /project bind alpha roadmap_1 --rebind.',
    })
    const text = formatOpenCodeUnavailableSessionLinks('ses_missing', {
      gatewayBaseUrl: 'http://127.0.0.1:5100/',
      reason: 'session not found in OpenCode API',
      actionHint: 'Run /project bind alpha roadmap_1 --rebind.',
    })

    expect(links).toMatchObject({
      sessionId: 'ses_missing',
      webUrl: undefined,
      webStatus: 'unavailable',
      webStatusReason: 'session not found in OpenCode API',
      webRecoveryHint: 'Run /project bind alpha roadmap_1 --rebind.',
      securityBoundary: LOCAL_SESSION_LINK_SECURITY_BOUNDARY,
      tuiCommand: 'opencode --session ses_missing',
      missionControlUrl: 'http://127.0.0.1:5100/dashboard',
      sessionEvidenceUrl: 'http://127.0.0.1:5100/opencode/sessions/ses_missing',
      operatorJourney: expect.objectContaining({
        surface: 'opencode_web_tui',
        recoveryPath: expect.objectContaining({ state: 'recoverable' }),
        channelCapability: 'fallback',
        proofState: 'missing',
      }),
    })
    expect(text).toContain('OpenCode Web: unavailable (session not found in OpenCode API)')
    expect(text).not.toContain('/session/ses_missing')
    expect(text).toContain('Web recovery: Run /project bind alpha roadmap_1 --rebind.')
    expect(text).toContain(`Security: ${LOCAL_SESSION_LINK_SECURITY_BOUNDARY}`)
    expect(text).toContain('Operator journey: Recover OpenCode Session link: fallback')
    expect(text).toContain('OpenCode TUI: opencode --session ses_missing')
    expect(text).toContain('Session evidence: http://127.0.0.1:5100/opencode/sessions/ses_missing')
  })
})

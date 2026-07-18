import { openCodeSessionLinkJourney, summarizeOperatorJourney, type OperatorJourneySnapshot } from './operator-journey.js'

export interface OpenCodeSessionLike {
  id: string
  path?: string
  directory?: string
}

export interface OpenCodeSessionLinks {
  sessionId: string
  webUrl?: string
  webStatus: 'metadata_only' | 'unavailable'
  webStatusReason: string
  webRecoveryHint: string
  securityBoundary: string
  tuiCommand: string
  directory?: string
  missionControlUrl: string
  sessionEvidenceUrl: string
  operatorJourney: OperatorJourneySnapshot
}

export interface OpenCodeSessionLinkOptions {
  gatewayBaseUrl?: string
}

export interface OpenCodeUnavailableSessionLinkOptions extends OpenCodeSessionLinkOptions {
  reason?: string
  actionHint?: string
}

export const LOCAL_SESSION_LINK_SECURITY_BOUNDARY = 'Local-only: OpenCode Web/TUI links work on this operator machine and must not be treated as hosted or shared URLs.'

export function opencodeSessionWebUrl(baseUrl: string, session: OpenCodeSessionLike): string {
  const base = baseUrl.replace(/\/$/, '')
  const directory = session.directory || pathToDirectory(session.path)
  if (!directory) return ''
  return `${base}/${encodeURIComponent(dirBase64(directory))}/session/${encodeURIComponent(session.id)}`
}

export function opencodeSessionTuiCommand(session: OpenCodeSessionLike, binary = 'opencode'): string {
  const directory = session.directory || pathToDirectory(session.path)
  return [binary, directory, '--session', session.id].filter(isString).map(shellQuote).join(' ')
}

export function opencodeSessionLinks(baseUrl: string, session: OpenCodeSessionLike, options: OpenCodeSessionLinkOptions = {}): OpenCodeSessionLinks {
  const directory = session.directory || pathToDirectory(session.path)
  const webUrl = opencodeSessionWebUrl(baseUrl, session) || undefined
  const gatewayBase = normalizeBaseUrl(options.gatewayBaseUrl || gatewayLocalBaseUrl())
  const webStatusReason = webUrl ? 'OpenCode API resolved this session, but Web can still transiently report it missing.' : 'session metadata missing directory/path'
  const webRecoveryHint = webUrl
    ? 'if Web says the session was not found, reload once; then use the TUI command or Mission Control evidence below.'
    : 'use the TUI command or Mission Control evidence below; Web deep links need session directory metadata.'
  const links: Omit<OpenCodeSessionLinks, 'operatorJourney'> = {
    sessionId: session.id,
    webUrl,
    webStatus: webUrl ? 'metadata_only' : 'unavailable',
    webStatusReason,
    webRecoveryHint,
    securityBoundary: LOCAL_SESSION_LINK_SECURITY_BOUNDARY,
    tuiCommand: opencodeSessionTuiCommand(session),
    directory,
    missionControlUrl: `${gatewayBase}/dashboard`,
    sessionEvidenceUrl: `${gatewayBase}/opencode/sessions/${encodeURIComponent(session.id)}`,
  }
  return { ...links, operatorJourney: openCodeSessionLinkJourney(links) }
}

export function formatOpenCodeSessionLinks(baseUrl: string, session: OpenCodeSessionLike, options: OpenCodeSessionLinkOptions = {}): string {
  const links = opencodeSessionLinks(baseUrl, session, options)
  return [
    links.webUrl ? `OpenCode Web: ${links.webUrl}` : 'OpenCode Web: unavailable (session metadata missing directory/path)',
    `Web recovery: ${links.webRecoveryHint}`,
    `Security: ${links.securityBoundary}`,
    `Operator journey: ${summarizeOperatorJourney(links.operatorJourney)}`,
    `OpenCode TUI: ${links.tuiCommand}`,
    `Mission Control: ${links.missionControlUrl}`,
    `Session evidence: ${links.sessionEvidenceUrl}`,
  ].join('\n')
}

export function unavailableOpenCodeSessionLinks(sessionId: string, options: OpenCodeUnavailableSessionLinkOptions = {}): OpenCodeSessionLinks {
  const gatewayBase = normalizeBaseUrl(options.gatewayBaseUrl || gatewayLocalBaseUrl())
  const reason = options.reason || 'session not found in OpenCode'
  const actionHint = options.actionHint || 'Use /new [title], /switch <sessionId>, or /project bind <alias> <roadmapId> --rebind to recover a fresh session.'
  const links: Omit<OpenCodeSessionLinks, 'operatorJourney'> = {
    sessionId,
    webUrl: undefined,
    webStatus: 'unavailable',
    webStatusReason: reason,
    webRecoveryHint: actionHint,
    securityBoundary: LOCAL_SESSION_LINK_SECURITY_BOUNDARY,
    tuiCommand: opencodeSessionTuiCommand({ id: sessionId }),
    missionControlUrl: `${gatewayBase}/dashboard`,
    sessionEvidenceUrl: `${gatewayBase}/opencode/sessions/${encodeURIComponent(sessionId)}`,
  }
  return { ...links, operatorJourney: openCodeSessionLinkJourney(links) }
}

export function formatOpenCodeUnavailableSessionLinks(sessionId: string, options: OpenCodeUnavailableSessionLinkOptions = {}): string {
  const links = unavailableOpenCodeSessionLinks(sessionId, options)
  return [
    `OpenCode Web: unavailable (${links.webStatusReason})`,
    `Web recovery: ${links.webRecoveryHint}`,
    `Security: ${links.securityBoundary}`,
    `Operator journey: ${summarizeOperatorJourney(links.operatorJourney)}`,
    `OpenCode TUI: ${links.tuiCommand}`,
    `Mission Control: ${links.missionControlUrl}`,
    `Session evidence: ${links.sessionEvidenceUrl}`,
  ].join('\n')
}

export function gatewayLocalBaseUrl(httpPort = 4097, httpHost = '127.0.0.1'): string {
  const host = !httpHost || httpHost === '0.0.0.0' || httpHost === '::' ? '127.0.0.1' : httpHost
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `http://${bracketed}:${httpPort}`
}

export function dirBase64(directory: string): string {
  return Buffer.from(directory, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function pathToDirectory(value?: string): string | undefined {
  if (!value) return undefined
  return value.startsWith('/') ? value : `/${value}`
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/, '')
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

function isString(value: string | undefined): value is string {
  return Boolean(value)
}

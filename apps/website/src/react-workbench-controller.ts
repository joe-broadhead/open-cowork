import type { CloudWebClientBootstrap } from './client-contract.ts'
import type { CloudWebThreadFilters, CloudWebThreadSession, CloudWebThreadView } from './thread-workbench.ts'

export type SessionListPage = {
  sessions: CloudWebThreadSession[]
  nextCursor: string | null
  totalEstimate: number | null
}

export type ArtifactPanelState = {
  artifactId: string | null
  metadata: Record<string, unknown> | null
  status: 'idle' | 'loading' | 'error'
  error: string | null
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asSessions(value: unknown): CloudWebThreadSession[] {
  return Array.isArray(value) ? value.filter((session): session is CloudWebThreadSession => Boolean(asRecord(session).sessionId)) : []
}

export function sessionIdFromCreateResult(value: unknown) {
  const record = asRecord(value)
  const session = asRecord(record.session)
  return String(session.sessionId || record.sessionId || '')
}

export function sessionViewFromCreateResult(value: unknown) {
  const record = asRecord(value)
  return (record.view && typeof record.view === 'object' ? record.view : value) as CloudWebThreadView
}

export function sessionTitle(view: CloudWebThreadView | null, fallback: string) {
  const projection = asRecord(view?.projection?.view)
  const session = asRecord(view?.session)
  return String(projection.title || session.title || fallback)
}

export function sessionMessageCount(view: CloudWebThreadView | null) {
  const projection = asRecord(view?.projection?.view)
  return Array.isArray(projection.messages) ? projection.messages.length : 0
}

export function projectionSequence(view: unknown) {
  const sequence = Math.floor(Number((view as CloudWebThreadView | null | undefined)?.projection?.sequence || 0))
  return Number.isFinite(sequence) && sequence > 0 ? sequence : 0
}

export function allowedAgentsFromWorkspace(workspace: unknown) {
  const policy = asRecord(asRecord(workspace).policy)
  const agents = policy.allowedAgents
  if (!Array.isArray(agents)) return []
  return agents.map((agent) => {
    if (typeof agent === 'string') return agent
    return String(asRecord(agent).name || '')
  }).filter((agent) => agent.trim().length > 0)
}

export function pageFromResponse(value: unknown): SessionListPage {
  const record = asRecord(value)
  return {
    sessions: asSessions(record.sessions),
    nextCursor: typeof record.nextCursor === 'string' && record.nextCursor ? record.nextCursor : null,
    totalEstimate: typeof record.totalEstimate === 'number' && Number.isFinite(record.totalEstimate) ? record.totalEstimate : null,
  }
}

export function mergeSessions(existing: CloudWebThreadSession[], incoming: CloudWebThreadSession[], append: boolean) {
  const merged = append ? [...existing] : []
  const positions = new Map(merged.map((session, index) => [session.sessionId, index]))
  for (const session of incoming) {
    const position = positions.get(session.sessionId)
    if (position === undefined) {
      positions.set(session.sessionId, merged.length)
      merged.push(session)
    } else {
      merged[position] = { ...merged[position], ...session }
    }
  }
  return merged
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || 'Request failed')
}

export function setCloudStatus(message: string, kind: 'ok' | 'warn' = 'ok') {
  for (const id of ['status', 'sidebar-status']) {
    const element = document.getElementById(id)
    if (!element) continue
    element.textContent = message
    element.setAttribute('data-kind', kind)
  }
}

export function closeCloudReviewPane() {
  const inspector = document.getElementById('chat-inspector') as HTMLElement | null
  const layout = document.querySelector<HTMLElement>('[data-workbench-layout="true"]')
  if (inspector) inspector.hidden = true
  if (layout) {
    layout.dataset.reviewOpen = 'false'
    layout.classList.remove('ui-workbench-layout--with-review')
  }
  document.getElementById('chat-inspector-toggle')?.setAttribute('aria-expanded', 'false')
  delete document.body.dataset.reviewPane
}

function currentControlValue(id: string) {
  const element = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null
  return element?.value || ''
}

export function readThreadFilters(): CloudWebThreadFilters {
  return {
    query: currentControlValue('thread-query') || currentControlValue('sidebar-thread-query'),
    status: currentControlValue('thread-status') || 'all',
    profile: currentControlValue('thread-profile'),
    project: currentControlValue('thread-project') || 'all',
    tag: currentControlValue('thread-tag'),
  }
}

export function syncThreadQueryControls(value: string) {
  for (const id of ['thread-query', 'sidebar-thread-query']) {
    const element = document.getElementById(id) as HTMLInputElement | null
    if (element && element.value !== value) element.value = value
  }
}

export function setRouteHash(route: string) {
  const next = `#${route}`
  if (window.location.hash !== next) window.location.hash = route
}

export function decodeBase64(dataBase64: unknown, contentType: unknown) {
  const binary = atob(String(dataBase64 || ''))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: String(contentType || 'application/octet-stream') })
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = filename || 'artifact'
    document.body.appendChild(link)
    link.click()
    link.remove()
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

export function chatFeatureEnabled(bootstrap: CloudWebClientBootstrap) {
  return bootstrap.features.chat !== false
}

import type { BadgeTone } from '@open-cowork/ui'
import type { IconName } from '@open-cowork/ui'
import type { PendingApproval } from '@open-cowork/shared'

// Typed permission-approval model.
//
// The runtime hands us an untyped `PendingApproval` whose only strong signals
// are the `tool` name and a loose `input` bag. This module turns that into a
// typed descriptor so each permission KIND (bash / file-write / web /
// web-search / task / mcp / external-directory) gets a contextual title, a
// plain-language message, and structured metadata (command, cwd, affected
// files) instead of a raw tool id + JSON dump.
//
// Everything here is a pure function of its inputs so the classifier, the
// signature, and the runaway ("doom-loop") detector can be unit-tested in
// isolation without React, i18n, or the store.

export type PermissionKind =
  | 'bash'
  | 'file-write'
  | 'web'
  | 'web-search'
  | 'task'
  | 'mcp'
  | 'external-directory'
  | 'integration'
  | 'other'

export type PermissionMetadataField = {
  key: string
  label: string
  value: string
  /** `code` renders monospace; `list` renders one item per line. */
  variant?: 'text' | 'code' | 'list'
}

/** A minimal translate signature compatible with the renderer `t(key, fallback, vars)`. */
export type TranslateFn = (key: string, fallback: string, vars?: Record<string, string | number>) => string

export type PermissionDescriptor = {
  kind: PermissionKind
  icon: IconName
  tone: BadgeTone
  typeLabel: string
  title: string
  message: string
  metadata: PermissionMetadataField[]
  /** Destructive actions get extra confirmation weight (delete / rm / drop). */
  destructive: boolean
}

type Bag = Record<string, unknown>

function str(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function firstString(input: Bag, keys: string[]): string {
  for (const key of keys) {
    const value = str(input?.[key]).trim()
    if (value) return value
  }
  return ''
}

function toolName(approval: Pick<PendingApproval, 'tool'>): string {
  return (approval.tool || '').toLowerCase()
}

const DESTRUCTIVE_PATTERN = /\b(rm|rmdir|del|delete|drop|truncate|destroy|format|mkfs|dd|shutdown|kill|force[-\s]?push)\b|rm\s+-rf/i

function looksDestructive(kind: PermissionKind, tool: string, input: Bag): boolean {
  if (kind === 'bash') {
    const command = firstString(input, ['command', 'cmd', 'script'])
    return DESTRUCTIVE_PATTERN.test(command)
  }
  return /\b(delete|remove|drop|destroy)\b/.test(tool)
}

/**
 * Classify a pending approval into a permission KIND from the tool name and
 * the shape of its input. Ordering is deliberate: the most specific signals
 * win first so an integration tool ("gmail_send_email") is not mistaken for a
 * generic MCP call.
 */
export function classifyPermission(approval: Pick<PendingApproval, 'tool' | 'input' | 'taskRunId'>): PermissionKind {
  const tool = toolName(approval)
  const input = (approval.input || {}) as Bag

  if (/^bash$|^shell$|(^|_)command($|_)|(^|_)exec($|_)|terminal/.test(tool) || 'command' in input) {
    return 'bash'
  }
  if (/web[_-]?search|websearch|(^|_)search($|_)/.test(tool) || ('query' in input && !('url' in input))) {
    return 'web-search'
  }
  if (/web[_-]?fetch|webfetch|(^|_)fetch($|_)|http|browse|crawl/.test(tool) || 'url' in input) {
    return 'web'
  }
  if (/external[_-]?dir|external[_-]?directory|(^|_)directory($|_)|worktree|add[_-]?dir/.test(tool)
    || 'directory' in input || 'externalDirectory' in input) {
    return 'external-directory'
  }
  if (/(^|_)write($|_)|(^|_)edit($|_)|apply[_-]?patch|(^|_)patch($|_)|create[_-]?file|todowrite/.test(tool)
    || 'filePath' in input || 'filepath' in input || (('path' in input) && ('content' in input || 'diff' in input))) {
    return 'file-write'
  }
  if (/^task$|subagent|delegate|spawn[_-]?agent/.test(tool) || 'agent' in input || Boolean(approval.taskRunId)) {
    return 'task'
  }
  // Known productivity integrations get their own copy but are technically MCP.
  if (/gmail|sheets|docs|slides|calendar|drive|notion|slack|linear|github|jira/.test(tool)) {
    return 'integration'
  }
  // A namespaced tool id (server_action) that reached none of the above is an MCP tool.
  if (tool.includes('_') || tool.includes('.') || tool.includes('__')) {
    return 'mcp'
  }
  return 'other'
}

const KIND_ICON: Record<PermissionKind, IconName> = {
  bash: 'wrench',
  'file-write': 'file-diff',
  web: 'network',
  'web-search': 'search',
  task: 'git-fork',
  mcp: 'blocks',
  'external-directory': 'folder',
  integration: 'zap',
  other: 'shield-check',
}

const KIND_TONE: Record<PermissionKind, BadgeTone> = {
  bash: 'warning',
  'file-write': 'info',
  web: 'info',
  'web-search': 'info',
  task: 'neutral',
  mcp: 'neutral',
  'external-directory': 'warning',
  integration: 'info',
  other: 'muted',
}

function affectedFiles(input: Bag): string[] {
  const raw = input.files ?? input.affectedFiles ?? input.paths
  if (Array.isArray(raw)) {
    return raw.map((entry) => str(entry).trim()).filter(Boolean)
  }
  const single = firstString(input, ['filePath', 'filepath', 'path', 'file'])
  return single ? [single] : []
}

function metaField(key: string, label: string, value: string, variant?: PermissionMetadataField['variant']): PermissionMetadataField | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  return { key, label, value: trimmed, variant }
}

/**
 * Produce the full typed descriptor for an approval: icon, tone, a contextual
 * title, a plain-language message, and structured metadata rows. `translate`
 * is injected (matching the renderer `t`) so this stays pure and testable.
 */
export function describePermission(
  approval: Pick<PendingApproval, 'tool' | 'input' | 'taskRunId' | 'description'>,
  translate: TranslateFn,
): PermissionDescriptor {
  const t = translate
  const kind = classifyPermission(approval)
  const input = (approval.input || {}) as Bag
  const tool = approval.tool || 'permission'
  const destructive = looksDestructive(kind, toolName(approval), input)
  const metadata: PermissionMetadataField[] = []

  let title: string
  let message: string

  switch (kind) {
    case 'bash': {
      const command = firstString(input, ['command', 'cmd', 'script'])
      const cwd = firstString(input, ['cwd', 'workingDirectory', 'directory'])
      title = destructive
        ? t('approval.type.bash.destructiveTitle', 'Run a destructive command')
        : t('approval.type.bash.title', 'Run a terminal command')
      message = t('approval.type.bash.message', 'A coworker wants to run a shell command on this machine.')
      metadata.push(metaField('command', t('approval.meta.command', 'Command'), command || tool, 'code')!)
      const cwdField = metaField('cwd', t('approval.meta.cwd', 'Working directory'), cwd)
      if (cwdField) metadata.push(cwdField)
      break
    }
    case 'file-write': {
      const files = affectedFiles(input)
      const diff = firstString(input, ['diff', 'patch'])
      title = files.length > 1
        ? t('approval.type.fileWrite.titleMany', 'Write changes to {{count}} files', { count: files.length })
        : t('approval.type.fileWrite.title', 'Write changes to a file')
      message = t('approval.type.fileWrite.message', 'A coworker wants to create or modify files in your workspace.')
      if (files.length) {
        metadata.push({ key: 'files', label: t('approval.meta.affectedFiles', 'Affected files'), value: files.join('\n'), variant: 'list' })
      }
      const diffField = metaField('diff', t('approval.meta.diff', 'Diff'), diff, 'code')
      if (diffField) metadata.push(diffField)
      break
    }
    case 'web': {
      const url = firstString(input, ['url', 'href', 'endpoint'])
      title = t('approval.type.web.title', 'Fetch a web resource')
      message = t('approval.type.web.message', 'A coworker wants to fetch content from the internet.')
      const urlField = metaField('url', t('approval.meta.url', 'URL'), url || tool, 'code')
      if (urlField) metadata.push(urlField)
      break
    }
    case 'web-search': {
      const query = firstString(input, ['query', 'q', 'search'])
      title = t('approval.type.webSearch.title', 'Search the web')
      message = t('approval.type.webSearch.message', 'A coworker wants to run a web search.')
      const queryField = metaField('query', t('approval.meta.query', 'Query'), query)
      if (queryField) metadata.push(queryField)
      break
    }
    case 'task': {
      const agent = firstString(input, ['agent', 'subagent', 'agentName'])
      const description = firstString(input, ['description', 'prompt', 'title']) || approval.description || ''
      title = t('approval.type.task.title', 'Delegate work to a coworker')
      message = t('approval.type.task.message', 'A coworker wants to spawn a specialist to run a subtask.')
      const agentField = metaField('agent', t('approval.meta.agent', 'Coworker'), agent)
      if (agentField) metadata.push(agentField)
      const taskField = metaField('task', t('approval.meta.task', 'Task'), description)
      if (taskField) metadata.push(taskField)
      break
    }
    case 'external-directory': {
      const dir = firstString(input, ['directory', 'externalDirectory', 'path', 'cwd'])
      title = t('approval.type.externalDirectory.title', 'Access a folder outside the workspace')
      message = t('approval.type.externalDirectory.message', 'A coworker wants to read or write files outside your project directory.')
      const dirField = metaField('directory', t('approval.meta.directory', 'Directory'), dir || tool, 'code')
      if (dirField) metadata.push(dirField)
      break
    }
    case 'integration': {
      const integration = describeIntegration(tool, input, t)
      title = integration.title
      message = integration.message
      if (integration.detail) {
        metadata.push({ key: 'detail', label: t('approval.meta.detail', 'Details'), value: integration.detail })
      }
      metadata.push({ key: 'tool', label: t('approval.meta.tool', 'Tool'), value: tool, variant: 'code' })
      break
    }
    case 'mcp': {
      const [server] = tool.split(/[_.]/)
      title = t('approval.type.mcp.title', 'Run an integration action')
      message = server
        ? t('approval.type.mcp.messageNamed', 'A coworker wants to run an action via the {{server}} integration.', { server })
        : t('approval.type.mcp.message', 'A coworker wants to run an action via a connected integration.')
      metadata.push({ key: 'tool', label: t('approval.meta.tool', 'Tool'), value: tool, variant: 'code' })
      const summary = summarizeArgs(input)
      const summaryField = metaField('args', t('approval.meta.arguments', 'Arguments'), summary)
      if (summaryField) metadata.push(summaryField)
      break
    }
    default: {
      title = t('approval.type.other.title', 'Allow an action')
      message = approval.description && approval.description !== tool
        ? approval.description
        : t('approval.type.other.message', 'A coworker is requesting permission to run a tool.')
      metadata.push({ key: 'tool', label: t('approval.meta.tool', 'Tool'), value: tool, variant: 'code' })
      const summary = summarizeArgs(input)
      const summaryField = metaField('args', t('approval.meta.arguments', 'Arguments'), summary)
      if (summaryField) metadata.push(summaryField)
      break
    }
  }

  return {
    kind,
    icon: KIND_ICON[kind],
    tone: KIND_TONE[kind],
    typeLabel: kindLabel(kind, t),
    title,
    message,
    metadata: metadata.filter(Boolean),
    destructive,
  }
}

function kindLabel(kind: PermissionKind, t: TranslateFn): string {
  switch (kind) {
    case 'bash': return t('approval.kind.bash', 'Terminal')
    case 'file-write': return t('approval.kind.fileWrite', 'File write')
    case 'web': return t('approval.kind.web', 'Web')
    case 'web-search': return t('approval.kind.webSearch', 'Web search')
    case 'task': return t('approval.kind.task', 'Delegation')
    case 'mcp': return t('approval.kind.mcp', 'Integration')
    case 'external-directory': return t('approval.kind.externalDirectory', 'External folder')
    case 'integration': return t('approval.kind.integration', 'Integration')
    default: return t('approval.kind.other', 'Action')
  }
}

function describeIntegration(tool: string, input: Bag, t: TranslateFn): { title: string; message: string; detail: string } {
  const name = tool.toLowerCase()
  if (/gmail|send|email/.test(name)) {
    const to = firstString(input, ['to', 'recipient', 'emailAddress'])
    const subject = firstString(input, ['subject', 'title'])
    return {
      title: t('approval.integration.sendEmail', 'Send an email'),
      message: t('approval.integration.sendEmail.message', 'A coworker wants to send an email on your behalf.'),
      detail: to ? `${to}${subject ? ` — "${subject}"` : ''}` : subject,
    }
  }
  if (/sheets/.test(name)) {
    return { title: t('approval.integration.spreadsheet', 'Update a spreadsheet'), message: t('approval.integration.spreadsheet.message', 'A coworker wants to create or edit a spreadsheet.'), detail: firstString(input, ['title', 'spreadsheetId']) }
  }
  if (/docs/.test(name)) {
    return { title: t('approval.integration.document', 'Update a document'), message: t('approval.integration.document.message', 'A coworker wants to create or edit a document.'), detail: firstString(input, ['title', 'documentId']) }
  }
  if (/slides|presentation/.test(name)) {
    return { title: t('approval.integration.presentation', 'Update a presentation'), message: t('approval.integration.presentation.message', 'A coworker wants to create or edit a presentation.'), detail: firstString(input, ['title']) }
  }
  if (/calendar/.test(name)) {
    return { title: t('approval.integration.event', 'Create a calendar event'), message: t('approval.integration.event.message', 'A coworker wants to add an event to your calendar.'), detail: firstString(input, ['summary', 'title']) }
  }
  if (/share|permission|drive/.test(name)) {
    return { title: t('approval.integration.share', 'Share a file'), message: t('approval.integration.share.message', 'A coworker wants to change who can access a file.'), detail: firstString(input, ['emailAddress', 'fileId']) }
  }
  return { title: t('approval.integration.generic', 'Run an integration action'), message: t('approval.type.mcp.message', 'A coworker wants to run an action via a connected integration.'), detail: summarizeArgs(input) }
}

function summarizeArgs(input: Bag): string {
  const entries = Object.entries(input || {})
  if (entries.length === 0) return ''
  return entries
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${formatArgValue(value)}`)
    .join(', ')
}

function formatArgValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.length}]`
  return '{…}'
}

// ---------------------------------------------------------------------------
// Runaway / "doom-loop" detection
// ---------------------------------------------------------------------------

/**
 * A stable signature for a request. Near-identical requests (same command,
 * same file, same URL) collapse to the same signature so a runaway loop is
 * detectable even as the runtime re-issues the request over and over.
 */
export function permissionSignature(approval: Pick<PendingApproval, 'tool' | 'input' | 'taskRunId'>): string {
  const kind = classifyPermission(approval)
  const input = (approval.input || {}) as Bag
  const norm = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ')
  let key: string
  switch (kind) {
    case 'bash': key = norm(firstString(input, ['command', 'cmd', 'script'])); break
    case 'file-write': key = norm(affectedFiles(input).join('|')); break
    case 'web': key = norm(firstString(input, ['url', 'href', 'endpoint'])); break
    case 'web-search': key = norm(firstString(input, ['query', 'q', 'search'])); break
    case 'external-directory': key = norm(firstString(input, ['directory', 'externalDirectory', 'path'])); break
    case 'task': key = norm(firstString(input, ['agent', 'subagent', 'agentName'])); break
    default: key = norm(`${approval.tool || ''}:${summarizeArgs(input)}`); break
  }
  return `${kind}:${key || (approval.tool || '').toLowerCase()}`
}

export type RunawaySample = {
  id: string
  signature: string
  /** Millisecond timestamp (or any monotonic value in the same unit as windowMs). */
  at: number
}

export type RunawayDetectionOptions = {
  /** Minimum repeats to flag a loop. Clamped to a floor of 2. Default 3. */
  threshold?: number
  /** Sliding window in the same unit as `at`. `0` disables the window (pure count). Default 20000. */
  windowMs?: number
}

export type RunawayCluster = {
  signature: string
  count: number
  ids: string[]
  firstAt: number
  lastAt: number
}

export type RunawayDetectionResult = {
  runaway: boolean
  clusters: RunawayCluster[]
  runawayIds: string[]
  runawaySignatures: string[]
}

const DEFAULT_THRESHOLD = 3
const DEFAULT_WINDOW_MS = 20_000

/**
 * Pure runaway detector. Groups samples by signature, then finds — per
 * signature — the largest burst of repeats that fit inside `windowMs`. Any
 * signature whose burst reaches `threshold` is flagged as a runaway loop.
 *
 * Deterministic and side-effect free so it can be unit-tested directly.
 */
export function detectRunawayApprovals(
  samples: readonly RunawaySample[],
  options: RunawayDetectionOptions = {},
): RunawayDetectionResult {
  const threshold = Math.max(2, Math.floor(options.threshold ?? DEFAULT_THRESHOLD))
  const windowMs = Math.max(0, options.windowMs ?? DEFAULT_WINDOW_MS)

  const bySignature = new Map<string, RunawaySample[]>()
  for (const sample of samples) {
    if (!sample || !sample.signature) continue
    const bucket = bySignature.get(sample.signature)
    if (bucket) bucket.push(sample)
    else bySignature.set(sample.signature, [sample])
  }

  const clusters: RunawayCluster[] = []
  for (const [signature, bucket] of bySignature) {
    const sorted = [...bucket].sort((left, right) => left.at - right.at)
    let bestStart = 0
    let bestEnd = -1
    let bestCount = 0
    let start = 0
    for (let end = 0; end < sorted.length; end++) {
      while (windowMs > 0 && sorted[end]!.at - sorted[start]!.at > windowMs) start++
      const count = end - start + 1
      if (count > bestCount) {
        bestCount = count
        bestStart = start
        bestEnd = end
      }
    }
    if (bestCount >= threshold && bestEnd >= bestStart) {
      const windowSamples = sorted.slice(bestStart, bestEnd + 1)
      clusters.push({
        signature,
        count: bestCount,
        ids: windowSamples.map((sample) => sample.id),
        firstAt: windowSamples[0]!.at,
        lastAt: windowSamples[windowSamples.length - 1]!.at,
      })
    }
  }

  clusters.sort((left, right) => (right.count - left.count) || (right.lastAt - left.lastAt))
  const runawayIds = [...new Set(clusters.flatMap((cluster) => cluster.ids))]

  return {
    runaway: clusters.length > 0,
    clusters,
    runawayIds,
    runawaySignatures: clusters.map((cluster) => cluster.signature),
  }
}

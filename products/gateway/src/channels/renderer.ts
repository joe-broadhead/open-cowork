import { Buffer } from 'node:buffer'
import { normalizeChannelRenderCapabilities, type ChannelCapabilities, type ChannelRenderCapabilities, type ChannelRenderCapability, type ChannelRenderMode } from './capabilities.js'

export type { ChannelCapabilities, ChannelRenderCapabilities, ChannelRenderCapability, ChannelRenderMode } from './capabilities.js'

export type StructuredMessageKind =
  | 'status'
  | 'progress'
  | 'gate_approval'
  | 'run_result'
  | 'generic'

export interface MessageFact {
  label: string
  value: string
}

export type RichMessageBlock =
  | { type: 'heading'; text: string; level?: 1 | 2 | 3 }
  | { type: 'text'; text: string }
  | { type: 'facts'; facts: MessageFact[] }
  | { type: 'table'; columns: string[]; rows: string[][] }
  | { type: 'details'; title: string; body: string }
  | { type: 'media'; url: string; alt: string; mimeType?: string }
  | { type: 'divider' }

export interface MessageAction {
  label: string
  command?: string
  url?: string
  style?: 'primary' | 'secondary' | 'danger'
}

export interface StructuredGatewayMessage {
  kind: StructuredMessageKind | string
  title: string
  summary?: string
  status?: string
  severity?: 'critical' | 'warning' | 'info' | 'success'
  blocks: RichMessageBlock[]
  actions?: MessageAction[]
  fallback: {
    plainText: string
    markdown?: string
  }
  preferredModes?: ChannelRenderMode[]
  metadata?: Record<string, string | number | boolean | null | undefined>
}

export interface RenderSelection {
  mode: ChannelRenderMode
  capabilities: Required<ChannelRenderCapabilities>
  missingCapabilities: ChannelRenderCapability[]
  degradedFrom?: ChannelRenderMode
}

export interface RenderedChannelMessage {
  mode: ChannelRenderMode
  text: string
  plainText: string
  markdown?: string
  richBlocks?: RichMessageBlock[]
  actions?: MessageAction[]
  missingCapabilities: ChannelRenderCapability[]
  degradedFrom?: ChannelRenderMode
}

export type NativeActionDeliveryKind = 'url' | 'callback' | 'copy'
export type NativeActionOmitReason = 'action_limit' | 'missing_label' | 'missing_identifier' | 'unsafe_url' | 'unsupported_url' | 'identifier_not_safe' | 'identifier_too_large'
export type NativeActionUrlMode = 'native' | 'callback' | 'omit'

export interface NativeActionDeliveryLimits {
  maxActions: number
  maxLabelChars: number
  maxIdentifierChars?: number
  maxCallbackBytes?: number
  maxCopyTextChars?: number
  maxDescriptionChars?: number
  supportsCopyText?: boolean
  urlMode?: NativeActionUrlMode
}

export interface NativeActionDeliveryItem {
  sourceIndex: number
  kind: NativeActionDeliveryKind
  label: string
  identifier: string
  style?: MessageAction['style']
  description?: string
}

export interface NativeActionDeliveryOmission {
  sourceIndex: number
  reason: NativeActionOmitReason
  label?: string
  identifier?: string
}

export interface NativeActionDeliveryPlan {
  actions: NativeActionDeliveryItem[]
  omitted: NativeActionDeliveryOmission[]
}

export interface ProgressCardInput {
  title: string
  status?: string
  summary?: string
  currentStep?: string
  completed?: number
  total?: number
  percent?: number
  facts?: MessageFact[]
  steps?: Array<{ label: string; status: string }>
  nextAction?: string
  actions?: MessageAction[]
}

export interface GateApprovalCardInput {
  gateId: string
  title: string
  reason: string
  taskId?: string
  roadmapId?: string
  stage?: string
  expiresAt?: string
  approveCommand: string
  rejectCommand: string
}

export interface RunResultCardInput {
  runId: string
  title: string
  status: string
  stage: string
  summary?: string
  sessionId?: string
  metrics?: MessageFact[]
  nextAction?: string
  actions?: MessageAction[]
}

interface CardTable {
  columns: string[]
  rows: string[][]
}

interface CardDetails {
  title: string
  body?: string
  values?: string[]
}

interface GatewayCardTemplateInput {
  kind: StructuredMessageKind | string
  title: string
  status?: string
  severity?: StructuredGatewayMessage['severity']
  summary?: string
  stateLabel?: string
  facts?: MessageFact[]
  nextAction?: string
  table?: CardTable
  details?: CardDetails[]
  actions?: MessageAction[]
}

const DEFAULT_MODE_ORDER: ChannelRenderMode[] = ['rich', 'markdown', 'plainText']
const FALLBACK_MAX_LINES = 80
const FALLBACK_MAX_CHARS = 3900
const FALLBACK_MAX_LINE_CHARS = 600

export function normalizeChannelCapabilities(capabilities: ChannelCapabilities | ChannelRenderCapabilities = {}): Required<ChannelRenderCapabilities> {
  return normalizeChannelRenderCapabilities(capabilities)
}

export function messageCapabilities(message: StructuredGatewayMessage): ChannelRenderCapability[] {
  const required = new Set<ChannelRenderCapability>(['plainText'])
  if (message.actions?.length) required.add('buttons')
  for (const block of message.blocks) {
    if (block.type === 'table') required.add('tables')
    if (block.type === 'details') required.add('collapsibleDetails')
    if (block.type === 'media') required.add('media')
  }
  return [...required]
}

export function selectRenderMode(message: StructuredGatewayMessage, capabilities: ChannelCapabilities | ChannelRenderCapabilities = {}, preferredModes?: ChannelRenderMode[]): RenderSelection {
  const normalized = normalizeChannelCapabilities(capabilities)
  const order = preferredModes?.length ? preferredModes : message.preferredModes?.length ? message.preferredModes : DEFAULT_MODE_ORDER
  const missingByMode = new Map<ChannelRenderMode, ChannelRenderCapability[]>()

  for (const mode of order) {
    const missing = missingCapabilitiesForMode(mode, message, normalized)
    missingByMode.set(mode, missing)
    if (missing.length === 0) {
      const degradedFrom = mode === order[0] ? undefined : order[0]
      return { mode, capabilities: normalized, missingCapabilities: [], degradedFrom }
    }
  }

  return {
    mode: 'plainText',
    capabilities: normalized,
    missingCapabilities: missingByMode.get(order[0]!) || [],
    degradedFrom: order[0] === 'plainText' ? undefined : order[0],
  }
}

export function renderStructuredMessage(message: StructuredGatewayMessage, capabilities: ChannelCapabilities | ChannelRenderCapabilities = {}, preferredModes?: ChannelRenderMode[]): RenderedChannelMessage {
  const selection = selectRenderMode(message, capabilities, preferredModes)
  const plainText = message.fallback.plainText || renderPlainTextFallback(message)
  const markdown = message.fallback.markdown || renderMarkdownFallback(message)
  if (selection.mode === 'rich') {
    return {
      mode: 'rich',
      text: plainText,
      plainText,
      markdown,
      richBlocks: message.blocks,
      actions: message.actions,
      missingCapabilities: selection.missingCapabilities,
      degradedFrom: selection.degradedFrom,
    }
  }
  if (selection.mode === 'markdown') {
    return {
      mode: 'markdown',
      text: markdown,
      plainText,
      markdown,
      missingCapabilities: selection.missingCapabilities,
      degradedFrom: selection.degradedFrom,
    }
  }
  return {
    mode: 'plainText',
    text: plainText,
    plainText,
    markdown,
    missingCapabilities: selection.missingCapabilities,
    degradedFrom: selection.degradedFrom,
  }
}

export function planNativeActionDelivery(actions: MessageAction[] | undefined, limits: NativeActionDeliveryLimits): NativeActionDeliveryPlan {
  const planned: NativeActionDeliveryItem[] = []
  const omitted: NativeActionDeliveryOmission[] = []
  const source = actions || []
  const urlMode = limits.urlMode || 'native'

  for (let index = 0; index < source.length; index++) {
    const action = source[index]!
    const label = cleanNativeActionText(action.label, limits.maxLabelChars)
    if (index >= limits.maxActions) {
      omitted.push({ sourceIndex: index, reason: 'action_limit', label })
      continue
    }
    if (!label) {
      omitted.push({ sourceIndex: index, reason: 'missing_label' })
      continue
    }

    const url = normalizeNativeIdentifier(action.url)
    if (url) {
      if (!safeHttpUrl(url)) {
        omitted.push({ sourceIndex: index, reason: 'unsafe_url', label, identifier: url })
        continue
      }
      if (urlMode === 'omit') {
        omitted.push({ sourceIndex: index, reason: 'unsupported_url', label, identifier: url })
        continue
      }
      if (urlMode === 'native') {
        planned.push(nativeAction(index, 'url', label, url, action, limits))
        continue
      }
      if (fitsIdentifier(url, limits)) {
        planned.push(nativeAction(index, 'callback', label, url, action, limits))
      } else {
        omitted.push({ sourceIndex: index, reason: 'identifier_too_large', label, identifier: url })
      }
      continue
    }

    const command = normalizeNativeIdentifier(action.command)
    if (!command) {
      omitted.push({ sourceIndex: index, reason: 'missing_identifier', label })
      continue
    }
    if (action.command && command !== String(action.command).trim()) {
      omitted.push({ sourceIndex: index, reason: 'identifier_not_safe', label, identifier: command })
      continue
    }
    if (fitsIdentifier(command, limits)) {
      planned.push(nativeAction(index, 'callback', label, command, action, limits))
      continue
    }
    if (limits.supportsCopyText && fitsCopyIdentifier(command, limits)) {
      planned.push(nativeAction(index, 'copy', label, command, action, limits))
      continue
    }
    omitted.push({ sourceIndex: index, reason: 'identifier_too_large', label, identifier: command })
  }

  return { actions: planned, omitted }
}

export function createStructuredMessage(input: Omit<StructuredGatewayMessage, 'fallback'> & { fallback?: Partial<StructuredGatewayMessage['fallback']> }): StructuredGatewayMessage {
  const draft: StructuredGatewayMessage = {
    ...input,
    blocks: input.blocks || [],
    fallback: { plainText: input.fallback?.plainText || '', markdown: input.fallback?.markdown },
  }
  return {
    ...draft,
    fallback: {
      plainText: draft.fallback.plainText || renderPlainTextFallback(draft),
      markdown: draft.fallback.markdown || renderMarkdownFallback(draft),
    },
  }
}

export function progressCard(input: ProgressCardInput): StructuredGatewayMessage {
  const facts: MessageFact[] = []
  if (input.currentStep) facts.push({ label: 'Current step', value: input.currentStep })
  if (typeof input.percent === 'number') facts.push({ label: 'Progress', value: `${Math.round(input.percent)}%` })
  if (typeof input.completed === 'number' && typeof input.total === 'number') facts.push({ label: 'Completed', value: `${input.completed}/${input.total}` })
  return cardTemplate({
    kind: 'progress',
    title: input.title,
    status: input.status,
    stateLabel: 'Status',
    summary: input.summary,
    facts: facts.concat(input.facts || []),
    nextAction: input.nextAction,
    table: { columns: ['Step', 'Status'], rows: (input.steps || []).map(step => [step.label, step.status]) },
    actions: input.actions,
  })
}

export function gateApprovalCard(input: GateApprovalCardInput): StructuredGatewayMessage {
  const facts = compactFacts([
    ['Gate', input.gateId],
    ['Task', input.taskId],
    ['Roadmap', input.roadmapId],
    ['Stage', input.stage],
    ['Expires', input.expiresAt],
  ])
  return cardTemplate({
    kind: 'gate_approval',
    title: input.title,
    status: 'approval_required',
    summary: input.reason,
    severity: 'warning',
    stateLabel: 'Status',
    facts,
    nextAction: 'Review the request and choose Approve once or Reject.',
    actions: [
      { label: 'Approve once', command: input.approveCommand, style: 'primary' },
      { label: 'Reject', command: input.rejectCommand, style: 'danger' },
    ],
  })
}

export function runResultCard(input: RunResultCardInput): StructuredGatewayMessage {
  return cardTemplate({
    kind: 'run_result',
    title: input.title,
    status: input.status,
    stateLabel: 'Status',
    summary: input.summary,
    facts: compactFacts([
      ['Run', input.runId],
      ['Stage', input.stage],
      ['Session', input.sessionId],
    ]).concat(input.metrics || []),
    nextAction: input.nextAction,
    actions: input.actions,
  })
}

export function renderPlainTextFallback(message: StructuredGatewayMessage): string {
  const lines: string[] = [message.title]
  if (message.status) lines.push(`Status: ${message.status}`)
  if (message.severity) lines.push(`Severity: ${message.severity}`)
  if (message.summary) lines.push(`Summary: ${message.summary}`)
  for (const block of message.blocks) {
    if (block.type === 'text' && block.text === message.summary) continue
    appendPlainBlock(lines, block)
  }
  if (message.actions?.length) {
    lines.push('Actions:')
    for (const action of message.actions) lines.push(`- ${action.label}: ${action.command || action.url || 'unavailable'}`)
  }
  return fallbackLines(lines).join('\n')
}

export function renderMarkdownFallback(message: StructuredGatewayMessage): string {
  const lines: string[] = [`## ${message.title}`]
  if (message.status) lines.push(`**Status:** ${message.status}`)
  if (message.severity) lines.push(`**Severity:** ${message.severity}`)
  if (message.summary) lines.push(message.summary)
  for (const block of message.blocks) {
    if (block.type === 'text' && block.text === message.summary) continue
    appendMarkdownBlock(lines, block)
  }
  if (message.actions?.length) {
    lines.push('**Actions:**')
    for (const action of message.actions) lines.push(`- ${action.label}: \`${action.command || action.url || 'unavailable'}\``)
  }
  return fallbackLines(lines).join('\n')
}

function cardTemplate(input: GatewayCardTemplateInput): StructuredGatewayMessage {
  const stateFacts = compactFacts([
    [input.stateLabel || 'Status', input.status],
    ['Severity', input.severity],
  ])
  const blocks: RichMessageBlock[] = [
    { type: 'heading', text: input.title, level: 2 },
    ...factsBlock(stateFacts),
    ...textBlock(input.summary),
    ...factsBlock(input.facts || []),
    ...factsBlock(input.nextAction ? [{ label: 'Next action', value: input.nextAction }] : []),
    ...tableBlock(input.table?.columns || [], input.table?.rows || []),
    ...(input.details || []).flatMap(details => details.body
      ? [{ type: 'details' as const, title: details.title, body: details.body }]
      : detailsBlock(details.title, details.values)),
  ]
  return createStructuredMessage({
    kind: input.kind,
    title: input.title,
    status: input.status,
    severity: input.severity,
    summary: input.summary,
    blocks,
    actions: input.actions,
  })
}

function missingCapabilitiesForMode(mode: ChannelRenderMode, message: StructuredGatewayMessage, capabilities: Required<ChannelRenderCapabilities>): ChannelRenderCapability[] {
  const required = mode === 'rich'
    ? ['plainText', 'richBlocks', ...messageCapabilities(message).filter(capability => capability !== 'plainText')]
    : mode === 'markdown'
      ? ['plainText', 'markdown']
      : ['plainText']
  return [...new Set(required as ChannelRenderCapability[])].filter(capability => !capabilities[capability])
}

function appendPlainBlock(lines: string[], block: RichMessageBlock): void {
  if (block.type === 'heading') return
  if (block.type === 'text') lines.push(block.text)
  if (block.type === 'facts') for (const fact of block.facts) lines.push(`${fact.label}: ${fact.value}`)
  if (block.type === 'table') {
    for (const row of block.rows) lines.push(`- ${block.columns.map((column, index) => `${column}: ${row[index] || ''}`).join('; ')}`)
  }
  if (block.type === 'details') lines.push(`${block.title}: ${block.body}`)
  if (block.type === 'media') lines.push(`Media: ${block.alt} (${block.url})`)
}

function appendMarkdownBlock(lines: string[], block: RichMessageBlock): void {
  if (block.type === 'heading') return
  if (block.type === 'text') lines.push(block.text)
  if (block.type === 'facts') for (const fact of block.facts) lines.push(`- **${fact.label}:** ${fact.value}`)
  if (block.type === 'table') {
    lines.push(`| ${block.columns.join(' |')} |`)
    lines.push(`| ${block.columns.map(() => '---').join(' |')} |`)
    for (const row of block.rows) lines.push(`| ${block.columns.map((_column, index) => row[index] || '').join(' |')} |`)
  }
  if (block.type === 'details') lines.push(`**${block.title}:** ${block.body}`)
  if (block.type === 'media') lines.push(`[${block.alt}](${block.url})`)
}

function textBlock(text?: string): RichMessageBlock[] {
  return text ? [{ type: 'text', text }] : []
}

function tableBlock(columns: string[], rows: string[][]): RichMessageBlock[] {
  return columns.length && rows.length ? [{ type: 'table', columns, rows }] : []
}

function detailsBlock(title: string, values?: string[]): RichMessageBlock[] {
  return values?.length ? [{ type: 'details', title, body: values.map(value => `- ${value}`).join('\n') }] : []
}

function factsBlock(facts: MessageFact[]): RichMessageBlock[] {
  return facts.length ? [{ type: 'facts', facts }] : []
}

function compactFacts(values: Array<[string, string | undefined]>): MessageFact[] {
  return values.filter((row): row is [string, string] => Boolean(row[1])).map(([label, value]) => ({ label, value }))
}

function fallbackLines(lines: string[]): string[] {
  const source = compactLines(lines).map(line => boundText(line, FALLBACK_MAX_LINE_CHARS))
  const out: string[] = []
  let chars = 0
  for (const line of source) {
    const nextChars = chars + line.length + (out.length ? 1 : 0)
    if (out.length >= FALLBACK_MAX_LINES || nextChars > FALLBACK_MAX_CHARS) break
    out.push(line)
    chars = nextChars
  }
  if (out.length < source.length) {
    const omitted = source.length - out.length
    const marker = `... truncated ${omitted} line${omitted === 1 ? '' : 's'}`
    while (out.length && chars + marker.length + 1 > FALLBACK_MAX_CHARS) {
      const removed = out.pop() || ''
      chars -= removed.length + (out.length ? 1 : 0)
    }
    out.push(marker)
  }
  return out
}

function nativeAction(sourceIndex: number, kind: NativeActionDeliveryKind, label: string, identifier: string, action: MessageAction, limits: NativeActionDeliveryLimits): NativeActionDeliveryItem {
  return {
    sourceIndex,
    kind,
    label,
    identifier,
    style: action.style,
    description: cleanNativeActionText(identifier, limits.maxDescriptionChars || 0),
  }
}

function fitsIdentifier(value: string, limits: NativeActionDeliveryLimits): boolean {
  if (limits.maxIdentifierChars && value.length > limits.maxIdentifierChars) return false
  if (limits.maxCallbackBytes && Buffer.byteLength(value, 'utf8') > limits.maxCallbackBytes) return false
  return true
}

function fitsCopyIdentifier(value: string, limits: NativeActionDeliveryLimits): boolean {
  if (limits.maxCopyTextChars && value.length > limits.maxCopyTextChars) return false
  if (limits.maxIdentifierChars && value.length > limits.maxIdentifierChars) return false
  return true
}

function normalizeNativeIdentifier(value: string | undefined): string {
  const raw = String(value || '').trim()
  if (!raw) return ''
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
}

function cleanNativeActionText(value: string | undefined, maxLength: number): string {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return maxLength > 0 && text.length > maxLength ? text.substring(0, maxLength) : text
}

function safeHttpUrl(value: string): string {
  try {
    const url = new URL(String(value || '').trim())
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : ''
  } catch {
    return ''
  }
}

function boundText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.substring(0, Math.max(0, maxChars - 14)).trimEnd()}... truncated`
}

function compactLines(lines: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const line of lines.map(line => line.trim()).filter(Boolean)) {
    const key = line
      .replace(/^-\s*/, '')
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(line)
    }
  }
  return out
}

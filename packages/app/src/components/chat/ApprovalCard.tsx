import { useState } from 'react'
import type { PendingApproval } from '../../stores/session'
import { useSessionStore } from '../../stores/session'
import { t } from '../../helpers/i18n'
import { Badge, Button, Card, Icon } from '../ui'

// Map tool names to user-friendly descriptions
function describeAction(tool: string, input: Record<string, unknown>): { verb: string; detail: string } {
  const name = tool.toLowerCase()
  if (name.includes('gmail') || name.includes('send') || name.includes('email')) {
    const to = input.to as string || ''
    const subject = input.subject as string || ''
    return { verb: t('approval.sendEmail', 'Send email'), detail: to ? `To: ${to}${subject ? ` — "${subject}"` : ''}` : '' }
  }
  if (name.includes('sheets') && name.includes('create')) {
    return { verb: t('approval.createSpreadsheet', 'Create spreadsheet'), detail: (input.title as string) || '' }
  }
  if (name.includes('docs') && name.includes('create')) {
    return { verb: t('approval.createDocument', 'Create document'), detail: (input.title as string) || '' }
  }
  if (name.includes('slides') && name.includes('create')) {
    return { verb: t('approval.createPresentation', 'Create presentation'), detail: (input.title as string) || '' }
  }
  if (name.includes('delete')) {
    return { verb: t('approval.delete', 'Delete'), detail: tool }
  }
  if (name.includes('share') || name.includes('permission')) {
    return { verb: t('approval.shareFile', 'Share file'), detail: (input.emailAddress as string) || '' }
  }
  if (name.includes('calendar') && name.includes('create')) {
    return { verb: t('approval.createEvent', 'Create event'), detail: (input.summary as string) || '' }
  }
  // Generic fallback (custom MCP + shell/file tools): show the raw tool id plus
  // a concise summary of the input args so the action isn't described by id alone.
  const argSummary = summarizeArgs(input)
  return {
    verb: t('approval.allowAction', 'Allow action'),
    detail: argSummary ? `${tool} — ${argSummary}` : tool,
  }
}

// Render a short, single-line preview of the tool input so a consequential
// action isn't approved on the strength of its raw tool id alone. The full
// JSON stays available behind the Inspect expander.
function summarizeArgs(input: Record<string, unknown>): string {
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

// Pretty-print the tool input for the Inspect expander; never throw on a value
// that can't be serialized (e.g. circular refs) so the approval card stays usable.
function safeStringifyInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

export function ApprovalCard({
  approval,
  queueCount = 1,
  onOpenSource,
}: {
  approval: PendingApproval
  queueCount?: number
  onOpenSource?: () => void
}) {
  const activeWorkspaceId = useSessionStore((state) => state.activeWorkspaceId)
  // The trust gate must respond exactly once: a re-entry guard + per-button pending
  // state stops a double-click from firing permission.respond twice.
  const [responding, setResponding] = useState<'allow' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const respond = async (allowed: boolean) => {
    if (responding) return
    setResponding(allowed ? 'allow' : 'deny')
    setError(null)
    try {
      await window.coworkApi.permission.respond(approval.id, allowed, approval.sessionId, {
        workspaceId: approval.workspaceId || activeWorkspaceId,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('approval.respondFailed', 'Could not send your response — please try again.'))
      setResponding(null)
    }
  }

  const { verb, detail } = describeAction(approval.tool, approval.input)
  const hasInput = approval.input && Object.keys(approval.input).length > 0
  const inputJson = hasInput ? safeStringifyInput(approval.input) : ''

  return (
    <Card className="chat-approval-card overflow-hidden" padding="md">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="chat-approval-icon">
            <Icon name="alert-circle" size={16} />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-medium text-text">{verb}</div>
              {queueCount > 1 ? <Badge tone="warning">{t('approval.queueCount', '{{count}} pending', { count: queueCount })}</Badge> : null}
            </div>
            {detail && <div className="text-2xs text-text-muted">{detail}</div>}
            {hasInput && (
              <details className="mt-1 group">
                <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-2xs text-text-muted hover:text-text">
                  <Icon name="chevron-right" size={16} className="transition-transform group-open:rotate-90" aria-hidden />
                  {t('approval.inspectInput', 'Inspect')}
                </summary>
                <pre className="mt-1.5 max-h-48 overflow-auto rounded-md bg-surface-hover p-2 text-2xs leading-relaxed text-text-secondary whitespace-pre-wrap break-words">
                  {inputJson}
                </pre>
              </details>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {onOpenSource ? (
            <Button onClick={onOpenSource} size="sm" variant="ghost" rightIcon="external-link">
              {t('approval.openSource', 'Source')}
            </Button>
          ) : null}
          <Button onClick={() => respond(false)} size="sm" variant="danger" loading={responding === 'deny'} disabled={responding !== null}>
            {t('approval.deny', 'Deny')}
          </Button>
          <Button onClick={() => respond(true)} size="sm" variant="primary" loading={responding === 'allow'} disabled={responding !== null}>
            {t('approval.approve', 'Approve')}
          </Button>
        </div>
      </div>
      {error ? (
        <div role="alert" className="mt-2 text-2xs text-red">{error}</div>
      ) : null}
    </Card>
  )
}

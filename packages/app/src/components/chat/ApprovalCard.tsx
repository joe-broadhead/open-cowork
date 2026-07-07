import { useMemo, useState } from 'react'
import type { PendingApproval } from '../../stores/session'
import { useSessionStore } from '../../stores/session'
import { t } from '../../helpers/i18n'
import { Badge, Button, Card, Icon } from '../ui'
import {
  describePermission,
  detectRunawayApprovals,
  permissionSignature,
  type PermissionDescriptor,
  type PermissionMetadataField,
} from './permission-approval-model'

// Repeats of the same signature within this window flag a runaway loop.
const RUNAWAY_THRESHOLD = 3
const RUNAWAY_WINDOW_MS = 20_000

// Pretty-print the raw tool input for the Inspect expander; never throw on a
// value that can't be serialized (e.g. circular refs) so the card stays usable.
function safeStringifyInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

function MetadataRow({ field }: { field: PermissionMetadataField }) {
  return (
    <div className="chat-approval-meta-row">
      <dt className="text-2xs font-medium uppercase tracking-wide text-text-muted">{field.label}</dt>
      <dd className="mt-0.5">
        {field.variant === 'code' ? (
          <pre className="max-h-40 overflow-auto rounded-md bg-surface-hover px-2 py-1.5 text-2xs leading-relaxed text-text-secondary whitespace-pre-wrap break-words">
            {field.value}
          </pre>
        ) : field.variant === 'list' ? (
          <ul className="space-y-0.5">
            {field.value.split('\n').map((line, index) => (
              <li key={`${field.key}-${index}`} className="text-2xs text-text-secondary break-words">{line}</li>
            ))}
          </ul>
        ) : (
          <div className="text-2xs text-text-secondary break-words">{field.value}</div>
        )}
      </dd>
    </div>
  )
}

function RunawayWarning({
  count,
  onRejectAll,
  disabled,
}: {
  count: number
  onRejectAll: () => void
  disabled: boolean
}) {
  return (
    <div role="alert" className="chat-approval-runaway mt-2 rounded-md border border-red/40 bg-red/10 p-2.5">
      <div className="flex items-start gap-2">
        <span className="text-red" aria-hidden>
          <Icon name="rotate-ccw" size={16} />
        </span>
        <div className="flex-1">
          <div className="text-2xs font-medium text-text">
            {t('approval.runaway.title', 'This request keeps repeating')}
          </div>
          <div className="text-2xs text-text-muted">
            {t('approval.runaway.body', 'A coworker has asked for this same permission {{count}} times in a row — it may be stuck in a loop.', { count })}
          </div>
        </div>
        <Button
          onClick={onRejectAll}
          size="sm"
          variant="danger"
          disabled={disabled}
          leftIcon="circle-x"
          aria-label={t('approval.runaway.rejectAll', 'Stop and reject all requests like this')}
        >
          {t('approval.runaway.rejectAllShort', 'Stop the loop')}
        </Button>
      </div>
    </div>
  )
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
  const recentApprovals = useSessionStore((state) => state.recentApprovals)
  const pendingApprovals = useSessionStore((state) => state.currentView.pendingApprovals)
  // The trust gate must respond exactly once: a re-entry guard + per-button pending
  // state stops a double-click from firing permission.respond twice.
  const [responding, setResponding] = useState<'allow' | 'deny' | 'reject-all' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const signature = useMemo(() => permissionSignature(approval), [approval])
  const descriptor = useMemo<PermissionDescriptor>(() => describePermission(approval, t), [approval])

  // Runaway detection is a pure function of the recent-signature history; the
  // card just asks whether THIS request's signature is currently looping.
  const runaway = useMemo(() => {
    const result = detectRunawayApprovals(recentApprovals, { threshold: RUNAWAY_THRESHOLD, windowMs: RUNAWAY_WINDOW_MS })
    const cluster = result.clusters.find((entry) => entry.signature === signature)
    return cluster ? { count: cluster.count } : null
  }, [recentApprovals, signature])

  const respondOne = async (id: string, allowed: boolean) => {
    await window.coworkApi.permission.respond(id, allowed, approval.sessionId, {
      workspaceId: approval.workspaceId || activeWorkspaceId,
    })
  }

  const respond = async (allowed: boolean) => {
    if (responding) return
    setResponding(allowed ? 'allow' : 'deny')
    setError(null)
    try {
      await respondOne(approval.id, allowed)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('approval.respondFailed', 'Could not send your response — please try again.'))
      setResponding(null)
    }
  }

  const rejectAllLikeThis = async () => {
    if (responding) return
    setResponding('reject-all')
    setError(null)
    // Deny every currently-pending request that shares this signature so a
    // stuck loop is stopped in one action, not one card at a time.
    const targets = pendingApprovals.filter((entry) => permissionSignature(entry) === signature)
    const ids = targets.length ? targets.map((entry) => entry.id) : [approval.id]
    try {
      for (const id of ids) {
        await respondOne(id, false)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('approval.respondFailed', 'Could not send your response — please try again.'))
      setResponding(null)
    }
  }

  const hasInput = approval.input && Object.keys(approval.input).length > 0
  const inputJson = hasInput ? safeStringifyInput(approval.input) : ''

  return (
    <Card className="chat-approval-card overflow-hidden" padding="md">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span className="chat-approval-icon" aria-hidden>
            <Icon name={descriptor.icon} size={16} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-medium text-text">{descriptor.title}</div>
              <Badge tone={descriptor.tone}>{descriptor.typeLabel}</Badge>
              {descriptor.destructive ? (
                <Badge tone="danger">{t('approval.destructive', 'Destructive')}</Badge>
              ) : null}
              {queueCount > 1 ? (
                <Badge tone="warning">{t('approval.queueCount', '{{count}} pending', { count: queueCount })}</Badge>
              ) : null}
            </div>
            <div className="mt-0.5 text-2xs text-text-muted">{descriptor.message}</div>
            {descriptor.metadata.length ? (
              <dl className="chat-approval-meta mt-2 space-y-1.5">
                {descriptor.metadata.map((field) => (
                  <MetadataRow key={field.key} field={field} />
                ))}
              </dl>
            ) : null}
            {hasInput && (
              <details className="mt-1.5 group">
                <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-2xs text-text-muted hover:text-text">
                  <Icon name="chevron-right" size={16} className="transition-transform group-open:rotate-90" aria-hidden />
                  {t('approval.inspectInput', 'Inspect raw request')}
                </summary>
                <pre className="mt-1.5 max-h-48 overflow-auto rounded-md bg-surface-hover p-2 text-2xs leading-relaxed text-text-secondary whitespace-pre-wrap break-words">
                  {inputJson}
                </pre>
              </details>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
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
      {runaway ? (
        <RunawayWarning count={runaway.count} onRejectAll={rejectAllLikeThis} disabled={responding !== null} />
      ) : null}
      {error ? (
        <div role="alert" className="mt-2 text-2xs text-red">{error}</div>
      ) : null}
    </Card>
  )
}

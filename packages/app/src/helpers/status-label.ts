import type { TaskRun } from '../stores/session'
import { t } from './i18n'

// Single source of truth for turning a task run's status into a
// human-readable label. Before this helper, AgentRunLane and TaskDrillIn
// each mapped the same `TaskRun['status']` union into their own ad-hoc
// casing ("done" vs "Complete", "errored" vs "Error"), so the same run
// read differently across surfaces. Centralising it keeps the wording —
// and its translations — consistent everywhere a status is shown.
//
// Labels reuse the established `taskStatus.*` catalog keys (already
// translated across every built-in locale), so the English defaults are
// the canonical baseline and every surface inherits the same wording.
// Callers that want different visual casing (e.g. a badge that uppercases,
// a lane that lowercases) apply it via CSS, not by re-wording the label.

const STATUS_LABEL_KEYS: Record<TaskRun['status'], { key: string; fallback: string }> = {
  running: { key: 'taskStatus.running', fallback: 'running' },
  complete: { key: 'taskStatus.done', fallback: 'done' },
  error: { key: 'taskStatus.errored', fallback: 'errored' },
  queued: { key: 'taskStatus.queued', fallback: 'queued' },
}

// Returns the canonical human label for a task run status. Unknown
// statuses (e.g. a future enum value reaching an older renderer) fall
// back to the raw value rather than rendering empty.
export function statusLabel(status: TaskRun['status']): string {
  const entry = STATUS_LABEL_KEYS[status]
  if (!entry) return t('taskStatus.unknown', String(status))
  return t(entry.key, entry.fallback)
}

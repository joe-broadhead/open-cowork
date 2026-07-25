import { formatDate, t } from './i18n'

// OpenCode SDK default titles arrive as "New session" or
// "New session - 2026-07-17T09:24:11.216Z". Rendering the raw ISO instant is
// runtime-host's recognizer (session-history-loader.ts) applied at display
// time: surfaces that show these titles humanize them instead of leaking the
// machine timestamp, while user- or history-derived titles pass through.
const DEFAULT_SDK_SESSION_TITLE_RE = /^New session(?: - (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?))?$/i

function parseInstant(value?: string | null): Date | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * Display title for a session, or null when the session has no usable title so
 * callers keep their existing fallbacks. SDK default titles become a localized
 * "New chat · Jul 17, 09:24" using the timestamp embedded in the title when
 * present, else the session's createdAt.
 */
export function displaySessionTitle(session: {
  title?: string | null
  createdAt?: string | null
}): string | null {
  const trimmed = session.title?.trim()
  if (!trimmed) return null
  const match = DEFAULT_SDK_SESSION_TITLE_RE.exec(trimmed)
  if (!match) return trimmed
  const instant = parseInstant(match[1] || session.createdAt)
  if (!instant) return t('session.newChat', 'New chat')
  return t('session.newChatAt', 'New chat · {{when}}', {
    when: formatDate(instant, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
  })
}

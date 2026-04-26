const SECOND_MS = 1_000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS

export function formatElapsedMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s'

  const totalSeconds = Math.floor(ms / SECOND_MS)
  if (totalSeconds < 60) return `${totalSeconds}s`

  const hours = Math.floor(ms / HOUR_MS)
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS)
  const seconds = Math.floor((ms % MINUTE_MS) / SECOND_MS)

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  return `${minutes}m ${seconds}s`
}

export function parseIsoToMs(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

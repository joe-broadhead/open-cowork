/** Pure time helpers for the clock MCP (JOE-871 in-process coverage). */

export const MS_PER_SECOND = 1000
export const MS_PER_MINUTE = 60 * MS_PER_SECOND
export const MS_PER_HOUR = 60 * MS_PER_MINUTE
export const MS_PER_DAY = 24 * MS_PER_HOUR

export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function assertTimeZone(value: string | undefined | null, fallback = systemTimeZone()): string {
  const zone = (value && value.trim()) || fallback
  try {
    // Throws RangeError for invalid IANA zones in modern engines.
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date())
    return zone
  } catch {
    throw new Error(`Invalid IANA timezone: ${zone}`)
  }
}

export function addDurationMs(
  startMs: number,
  input: { days?: number, hours?: number, minutes?: number, seconds?: number, milliseconds?: number },
): number {
  return startMs
    + (input.days || 0) * MS_PER_DAY
    + (input.hours || 0) * MS_PER_HOUR
    + (input.minutes || 0) * MS_PER_MINUTE
    + (input.seconds || 0) * MS_PER_SECOND
    + (input.milliseconds || 0)
}

export function textResult(value: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(value),
    }],
  }
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  assertTimeZone,
  systemTimeZone,
  textResult,
} from './time-math.ts'

const dateTimeSchema = z.string().min(1).describe('ISO instant, ISO date, or local date-time. Local date-times require a timezone.')
const timezoneSchema = z.string().min(1).describe('IANA timezone, for example UTC, Europe/London, or America/New_York.')
const weekStartsOnSchema = z.enum(['sunday', 'monday']).optional().default('sunday')

type ZonedParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function toNumber(value: string | undefined, fallback = 0) {
  const numeric = Number.parseInt(value || '', 10)
  return Number.isFinite(numeric) ? numeric : fallback
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function clampDayOfMonth(year: number, month: number, requested: number) {
  return Math.max(1, Math.min(requested, daysInMonth(year, month)))
}

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const map = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]))
  return {
    year: toNumber(map.year),
    month: toNumber(map.month),
    day: toNumber(map.day),
    hour: toNumber(map.hour),
    minute: toNumber(map.minute),
    second: toNumber(map.second),
  }
}

function getTimeZoneOffsetMs(timeZone: string, date: Date) {
  const zoned = getZonedParts(date, timeZone)
  const utc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second)
  return utc - date.getTime()
}

function formatOffset(offsetMs: number) {
  const sign = offsetMs >= 0 ? '+' : '-'
  // Intl.DateTimeFormat gives local calendar parts only to whole-second
  // precision. Round to the nearest minute so an instant with milliseconds
  // does not turn UTC+02:00 into +01:59.
  const absoluteMinutes = Math.round(Math.abs(offsetMs) / MS_PER_MINUTE)
  const hours = Math.floor(absoluteMinutes / 60)
  const minutes = absoluteMinutes % 60
  return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function zonedDateTimeToUtc(timeZone: string, parts: ZonedParts) {
  const guess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second))
  const firstOffset = getTimeZoneOffsetMs(timeZone, guess)
  const candidate = new Date(guess.getTime() - firstOffset)
  const secondOffset = getTimeZoneOffsetMs(timeZone, candidate)
  return new Date(guess.getTime() - (secondOffset !== firstOffset ? secondOffset : firstOffset))
}

function addLocalDays(parts: ZonedParts, days: number): ZonedParts {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute, parts.second))
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  }
}

function localDateKey(parts: ZonedParts) {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

function localTimeKey(parts: ZonedParts) {
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}`
}

function describeInstant(date: Date, timeZone: string) {
  const parts = getZonedParts(date, timeZone)
  const offsetMs = getTimeZoneOffsetMs(timeZone, date)
  return {
    instant: date.toISOString(),
    unixMs: date.getTime(),
    timezone: timeZone,
    offset: formatOffset(offsetMs),
    localDate: localDateKey(parts),
    localTime: localTimeKey(parts),
    localDateTime: `${localDateKey(parts)}T${localTimeKey(parts)}`,
    weekday: new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(date),
    utc: date.toISOString(),
  }
}

function hasExplicitOffset(value: string) {
  return /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value.trim())
}

function parseLocalDateTime(value: string): ZonedParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4] || '0')
  const minute = Number(match[5] || '0')
  const second = Number(match[6] || '0')
  if (month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth(year, month)) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null
  return { year, month, day, hour, minute, second }
}

function parseInstant(value: string, options: { timezone?: string | null; field: string }) {
  if (hasExplicitOffset(value)) {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) throw new Error(`${options.field} is not a valid ISO datetime.`)
    return date
  }

  if (!options.timezone) {
    throw new Error(`${options.field} is a local datetime and requires a timezone.`)
  }

  const timeZone = assertTimeZone(options.timezone)
  const parts = parseLocalDateTime(value)
  if (!parts) throw new Error(`${options.field} is not a valid local datetime.`)
  return zonedDateTimeToUtc(timeZone, parts)
}

function addCalendar(date: Date, timeZone: string, input: {
  years: number
  months: number
  weeks: number
  days: number
}) {
  const parts = getZonedParts(date, timeZone)
  const monthIndex = parts.month - 1 + input.months + input.years * 12
  const monthStart = new Date(Date.UTC(parts.year, monthIndex, 1))
  const targetYear = monthStart.getUTCFullYear()
  const targetMonth = monthStart.getUTCMonth() + 1
  const clampedDay = clampDayOfMonth(targetYear, targetMonth, parts.day)
  const shifted = new Date(Date.UTC(targetYear, targetMonth - 1, clampedDay + input.weeks * 7 + input.days))
  return zonedDateTimeToUtc(timeZone, {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  })
}

function localMidnight(parts: ZonedParts, timeZone: string) {
  return zonedDateTimeToUtc(timeZone, {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: 0,
    minute: 0,
    second: 0,
  })
}

function localDateDiffDays(start: ZonedParts, end: ZonedParts) {
  const startUtc = Date.UTC(start.year, start.month - 1, start.day)
  const endUtc = Date.UTC(end.year, end.month - 1, end.day)
  return Math.round((endUtc - startUtc) / MS_PER_DAY)
}

function monthShift(year: number, month: number, delta: number) {
  const shifted = new Date(Date.UTC(year, month - 1 + delta, 1))
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 }
}

const server = new McpServer({
  name: 'clock',
  version: '1.0.0',
})

server.tool(
  'current_time',
  'Return the authoritative current date and time for an IANA timezone. Use this instead of guessing today, now, weekdays, or offsets.',
  {
    timezone: timezoneSchema.optional().describe('Timezone to report. Defaults to the host timezone.'),
  },
  async ({ timezone }) => {
    const timeZone = assertTimeZone(timezone)
    return textResult({
      kind: 'current_time',
      now: describeInstant(new Date(), timeZone),
      systemTimezone: systemTimeZone(),
    })
  },
)

server.tool(
  'convert_time',
  'Convert an instant or source-local datetime into another timezone.',
  {
    time: dateTimeSchema,
    from_timezone: timezoneSchema.optional().describe('Required when time has no explicit UTC offset.'),
    to_timezone: timezoneSchema.describe('Target IANA timezone.'),
  },
  async ({ time, from_timezone, to_timezone }) => {
    const sourceZone = from_timezone ? assertTimeZone(from_timezone) : null
    const targetZone = assertTimeZone(to_timezone)
    const instant = parseInstant(time, { timezone: sourceZone, field: 'time' })
    return textResult({
      kind: 'convert_time',
      input: { time, fromTimezone: sourceZone },
      target: describeInstant(instant, targetZone),
      source: sourceZone ? describeInstant(instant, sourceZone) : describeInstant(instant, 'UTC'),
    })
  },
)

server.tool(
  'date_math',
  'Add or subtract calendar and clock units. Calendar units are applied in the selected timezone before exact time units.',
  {
    time: dateTimeSchema.optional().describe('Base time. Defaults to now. Local date-times require timezone.'),
    timezone: timezoneSchema.optional().describe('Timezone for calendar math. Defaults to the host timezone.'),
    years: z.number().int().optional().default(0),
    months: z.number().int().optional().default(0),
    weeks: z.number().int().optional().default(0),
    days: z.number().int().optional().default(0),
    hours: z.number().int().optional().default(0),
    minutes: z.number().int().optional().default(0),
    seconds: z.number().int().optional().default(0),
  },
  async ({ time, timezone, years, months, weeks, days, hours, minutes, seconds }) => {
    const timeZone = assertTimeZone(timezone)
    const base = time ? parseInstant(time, { timezone: timeZone, field: 'time' }) : new Date()
    const calendarAdjusted = addCalendar(base, timeZone, {
      years: years ?? 0,
      months: months ?? 0,
      weeks: weeks ?? 0,
      days: days ?? 0,
    })
    const result = new Date(
      calendarAdjusted.getTime()
      + (hours ?? 0) * MS_PER_HOUR
      + (minutes ?? 0) * MS_PER_MINUTE
      + (seconds ?? 0) * MS_PER_SECOND,
    )
    return textResult({
      kind: 'date_math',
      timezone: timeZone,
      delta: {
        years: years ?? 0,
        months: months ?? 0,
        weeks: weeks ?? 0,
        days: days ?? 0,
        hours: hours ?? 0,
        minutes: minutes ?? 0,
        seconds: seconds ?? 0,
      },
      base: describeInstant(base, timeZone),
      result: describeInstant(result, timeZone),
    })
  },
)

server.tool(
  'date_range',
  'Resolve common calendar ranges such as today, last week, this month, next quarter, or a rolling N-day window.',
  {
    range: z.enum([
      'today',
      'yesterday',
      'tomorrow',
      'this_week',
      'last_week',
      'next_week',
      'this_month',
      'last_month',
      'next_month',
      'this_quarter',
      'last_quarter',
      'next_quarter',
      'this_year',
      'last_year',
      'next_year',
      'rolling_days',
    ]),
    timezone: timezoneSchema.optional().describe('Timezone for calendar boundaries. Defaults to the host timezone.'),
    anchor: dateTimeSchema.optional().describe('Anchor instant or local datetime. Defaults to now.'),
    week_starts_on: weekStartsOnSchema.describe('Week boundary for weekly ranges. Defaults to Sunday.'),
    rolling_days: z.number().int().min(1).max(366).optional().describe('Number of calendar days for rolling_days, including the anchor day.'),
  },
  async ({ range, timezone, anchor, week_starts_on, rolling_days }) => {
    const timeZone = assertTimeZone(timezone)
    const anchorInstant = anchor ? parseInstant(anchor, { timezone: timeZone, field: 'anchor' }) : new Date()
    const anchorParts = getZonedParts(anchorInstant, timeZone)
    const anchorDayStart = { ...anchorParts, hour: 0, minute: 0, second: 0 }
    let startParts = anchorDayStart
    let endParts = addLocalDays(anchorDayStart, 1)

    if (range === 'yesterday') {
      startParts = addLocalDays(anchorDayStart, -1)
      endParts = anchorDayStart
    } else if (range === 'tomorrow') {
      startParts = addLocalDays(anchorDayStart, 1)
      endParts = addLocalDays(anchorDayStart, 2)
    } else if (range.endsWith('_week')) {
      const day = new Date(Date.UTC(anchorParts.year, anchorParts.month - 1, anchorParts.day)).getUTCDay()
      const weekOffset = week_starts_on === 'sunday' ? day : (day + 6) % 7
      const thisWeekStart = addLocalDays(anchorDayStart, -weekOffset)
      const shift = range === 'last_week' ? -7 : range === 'next_week' ? 7 : 0
      startParts = addLocalDays(thisWeekStart, shift)
      endParts = addLocalDays(startParts, 7)
    } else if (range.endsWith('_month')) {
      const shift = range === 'last_month' ? -1 : range === 'next_month' ? 1 : 0
      const shifted = monthShift(anchorParts.year, anchorParts.month, shift)
      const end = monthShift(shifted.year, shifted.month, 1)
      startParts = { year: shifted.year, month: shifted.month, day: 1, hour: 0, minute: 0, second: 0 }
      endParts = { year: end.year, month: end.month, day: 1, hour: 0, minute: 0, second: 0 }
    } else if (range.endsWith('_quarter')) {
      const currentQuarterMonth = Math.floor((anchorParts.month - 1) / 3) * 3 + 1
      const shift = range === 'last_quarter' ? -3 : range === 'next_quarter' ? 3 : 0
      const shifted = monthShift(anchorParts.year, currentQuarterMonth, shift)
      const end = monthShift(shifted.year, shifted.month, 3)
      startParts = { year: shifted.year, month: shifted.month, day: 1, hour: 0, minute: 0, second: 0 }
      endParts = { year: end.year, month: end.month, day: 1, hour: 0, minute: 0, second: 0 }
    } else if (range.endsWith('_year')) {
      const shift = range === 'last_year' ? -1 : range === 'next_year' ? 1 : 0
      const year = anchorParts.year + shift
      startParts = { year, month: 1, day: 1, hour: 0, minute: 0, second: 0 }
      endParts = { year: year + 1, month: 1, day: 1, hour: 0, minute: 0, second: 0 }
    } else if (range === 'rolling_days') {
      const count = rolling_days ?? 7
      startParts = addLocalDays(anchorDayStart, -(count - 1))
      endParts = addLocalDays(anchorDayStart, 1)
    }

    const start = localMidnight(startParts, timeZone)
    const end = localMidnight(endParts, timeZone)
    return textResult({
      kind: 'date_range',
      range,
      timezone: timeZone,
      weekStartsOn: week_starts_on,
      rollingDays: range === 'rolling_days' ? rolling_days ?? 7 : null,
      anchor: describeInstant(anchorInstant, timeZone),
      startInclusive: describeInstant(start, timeZone),
      endExclusive: describeInstant(end, timeZone),
      calendarDays: localDateDiffDays(startParts, endParts),
    })
  },
)

server.tool(
  'duration_between',
  'Measure the signed duration between two instants or local datetimes.',
  {
    start: dateTimeSchema,
    end: dateTimeSchema,
    start_timezone: timezoneSchema.optional().describe('Required when start has no explicit UTC offset.'),
    end_timezone: timezoneSchema.optional().describe('Required when end has no explicit UTC offset.'),
    calendar_timezone: timezoneSchema.optional().describe('Timezone used for calendar-day difference. Defaults to the host timezone.'),
  },
  async ({ start, end, start_timezone, end_timezone, calendar_timezone }) => {
    const startZone = start_timezone ? assertTimeZone(start_timezone) : null
    const endZone = end_timezone ? assertTimeZone(end_timezone) : null
    const calendarZone = assertTimeZone(calendar_timezone)
    const startInstant = parseInstant(start, { timezone: startZone, field: 'start' })
    const endInstant = parseInstant(end, { timezone: endZone, field: 'end' })
    const milliseconds = endInstant.getTime() - startInstant.getTime()
    const absoluteMilliseconds = Math.abs(milliseconds)
    const startParts = getZonedParts(startInstant, calendarZone)
    const endParts = getZonedParts(endInstant, calendarZone)
    return textResult({
      kind: 'duration_between',
      direction: milliseconds === 0 ? 'zero' : milliseconds > 0 ? 'forward' : 'backward',
      milliseconds,
      absoluteMilliseconds,
      seconds: milliseconds / MS_PER_SECOND,
      minutes: milliseconds / MS_PER_MINUTE,
      hours: milliseconds / MS_PER_HOUR,
      days: milliseconds / MS_PER_DAY,
      calendarDays: localDateDiffDays(startParts, endParts),
      start: describeInstant(startInstant, startZone || calendarZone),
      end: describeInstant(endInstant, endZone || calendarZone),
      calendarTimezone: calendarZone,
    })
  },
)

process.stderr.write('[clock-mcp] Server started\n')
const transport = new StdioServerTransport()
await server.connect(transport)

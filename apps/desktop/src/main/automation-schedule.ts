import type { AutomationSchedule } from '@open-cowork/shared'

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

function getFormatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
}

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = getFormatter(timeZone)
  const parts = formatter.formatToParts(date)
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]))
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
  const utc = Date.UTC(
    zoned.year,
    zoned.month - 1,
    zoned.day,
    zoned.hour,
    zoned.minute,
    zoned.second,
  )
  return utc - date.getTime()
}

function zonedDateTimeToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0))
  const firstOffset = getTimeZoneOffsetMs(timeZone, guess)
  const candidate = new Date(guess.getTime() - firstOffset)
  const secondOffset = getTimeZoneOffsetMs(timeZone, candidate)
  if (secondOffset !== firstOffset) {
    return new Date(guess.getTime() - secondOffset)
  }
  return candidate
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function clampDayOfMonth(year: number, month: number, requested: number) {
  return Math.max(1, Math.min(requested, daysInMonth(year, month)))
}

function addDays(parts: ZonedParts, days: number): ZonedParts {
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

function sameLocalTime(schedule: AutomationSchedule, date: Date) {
  const parts = getZonedParts(date, schedule.timezone)
  const runAtHour = schedule.runAtHour ?? 9
  const runAtMinute = schedule.runAtMinute ?? 0
  return parts.hour === runAtHour && parts.minute === runAtMinute
}

export function validateAutomationSchedule(schedule: AutomationSchedule) {
  if (!schedule?.type) return 'Schedule type is required.'
  if (!schedule.timezone) return 'Schedule timezone is required.'
  if (schedule.type === 'weekly' && (typeof schedule.dayOfWeek !== 'number' || schedule.dayOfWeek < 0 || schedule.dayOfWeek > 6)) {
    return 'Weekly schedules require dayOfWeek between 0 and 6.'
  }
  if (schedule.type === 'monthly' && (typeof schedule.dayOfMonth !== 'number' || schedule.dayOfMonth < 1 || schedule.dayOfMonth > 31)) {
    return 'Monthly schedules require dayOfMonth between 1 and 31.'
  }
  if (schedule.type === 'one_time' && !schedule.startAt) {
    return 'One-time schedules require startAt.'
  }
  return null
}

export function computeNextAutomationRunAt(schedule: AutomationSchedule, from = new Date()) {
  const runAtHour = schedule.runAtHour ?? 9
  const runAtMinute = schedule.runAtMinute ?? 0
  const zonedNow = getZonedParts(from, schedule.timezone)

  if (schedule.type === 'one_time') {
    const at = schedule.startAt ? new Date(schedule.startAt) : null
    if (!at || Number.isNaN(at.getTime())) return null
    return at.getTime() > from.getTime() ? at.toISOString() : null
  }

  if (schedule.type === 'daily') {
    let candidate = zonedDateTimeToUtc(schedule.timezone, zonedNow.year, zonedNow.month, zonedNow.day, runAtHour, runAtMinute)
    if (candidate.getTime() <= from.getTime()) {
      const tomorrow = addDays(zonedNow, 1)
      candidate = zonedDateTimeToUtc(schedule.timezone, tomorrow.year, tomorrow.month, tomorrow.day, runAtHour, runAtMinute)
    }
    return candidate.toISOString()
  }

  if (schedule.type === 'weekly') {
    const currentDay = new Date(Date.UTC(zonedNow.year, zonedNow.month - 1, zonedNow.day)).getUTCDay()
    const targetDay = schedule.dayOfWeek ?? 1
    let delta = targetDay - currentDay
    if (delta < 0 || (delta === 0 && sameLocalTime(schedule, from))) {
      delta += 7
    }
    const target = addDays(zonedNow, delta)
    let candidate = zonedDateTimeToUtc(schedule.timezone, target.year, target.month, target.day, runAtHour, runAtMinute)
    if (candidate.getTime() <= from.getTime()) {
      const nextWeek = addDays(target, 7)
      candidate = zonedDateTimeToUtc(schedule.timezone, nextWeek.year, nextWeek.month, nextWeek.day, runAtHour, runAtMinute)
    }
    return candidate.toISOString()
  }

  const requestedDay = schedule.dayOfMonth ?? 1
  const day = clampDayOfMonth(zonedNow.year, zonedNow.month, requestedDay)
  let candidate = zonedDateTimeToUtc(schedule.timezone, zonedNow.year, zonedNow.month, day, runAtHour, runAtMinute)
  if (candidate.getTime() <= from.getTime()) {
    const nextMonth = zonedNow.month === 12
      ? { year: zonedNow.year + 1, month: 1 }
      : { year: zonedNow.year, month: zonedNow.month + 1 }
    candidate = zonedDateTimeToUtc(
      schedule.timezone,
      nextMonth.year,
      nextMonth.month,
      clampDayOfMonth(nextMonth.year, nextMonth.month, requestedDay),
      runAtHour,
      runAtMinute,
    )
  }
  return candidate.toISOString()
}

export function isAutomationDue(nextRunAt: string | null | undefined, now = new Date()) {
  if (!nextRunAt) return false
  const dueAt = new Date(nextRunAt)
  if (Number.isNaN(dueAt.getTime())) return false
  return dueAt.getTime() <= now.getTime()
}

const WEEKDAY_ORDER = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const

const WEEKDAY_ALIASES = new Map<string, string>([
  ['sun', 'sunday'],
  ['sun.', 'sunday'],
  ['mon', 'monday'],
  ['mon.', 'monday'],
  ['tue', 'tuesday'],
  ['tues', 'tuesday'],
  ['tue.', 'tuesday'],
  ['tues.', 'tuesday'],
  ['wed', 'wednesday'],
  ['wed.', 'wednesday'],
  ['thu', 'thursday'],
  ['thur', 'thursday'],
  ['thurs', 'thursday'],
  ['thu.', 'thursday'],
  ['thur.', 'thursday'],
  ['thurs.', 'thursday'],
  ['fri', 'friday'],
  ['fri.', 'friday'],
  ['sat', 'saturday'],
  ['sat.', 'saturday'],
])

const MONTH_ORDER = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const

const MONTH_ALIASES = new Map<string, string>([
  ['jan', 'january'],
  ['jan.', 'january'],
  ['feb', 'february'],
  ['feb.', 'february'],
  ['mar', 'march'],
  ['mar.', 'march'],
  ['apr', 'april'],
  ['apr.', 'april'],
  ['jun', 'june'],
  ['jun.', 'june'],
  ['jul', 'july'],
  ['jul.', 'july'],
  ['aug', 'august'],
  ['aug.', 'august'],
  ['sep', 'september'],
  ['sept', 'september'],
  ['sep.', 'september'],
  ['sept.', 'september'],
  ['oct', 'october'],
  ['oct.', 'october'],
  ['nov', 'november'],
  ['nov.', 'november'],
  ['dec', 'december'],
  ['dec.', 'december'],
])

type ChartRow = Record<string, unknown>
type VegaEncoding = Record<string, unknown>

function normalizeToken(value: unknown) {
  return String(value).trim().toLowerCase()
}

function canonicalizeKnownToken(
  value: unknown,
  aliases: Map<string, string>,
  validValues: readonly string[],
) {
  const normalized = normalizeToken(value)
  const alias = aliases.get(normalized) || normalized
  return validValues.includes(alias as typeof validValues[number]) ? alias : null
}

function uniqueInEncounterOrder(values: unknown[]) {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const value of values) {
    const key = String(value)
    if (seen.has(key)) continue
    seen.add(key)
    ordered.push(key)
  }
  return ordered
}

function parseTemporalString(value: string) {
  const trimmed = value.trim()
  if (!/\d/.test(trimmed)) return null
  const epoch = Date.parse(trimmed)
  return Number.isFinite(epoch) ? epoch : null
}

export function getFieldValues(data: ChartRow[], field: string) {
  return data
    .map((row) => row[field])
    .filter((value) => value != null)
}

function isFiniteNumericField(data: ChartRow[], field: string) {
  const values = getFieldValues(data, field)
  return values.length > 0 && values.every((value) => typeof value === 'number' && Number.isFinite(value))
}

export function inferBarChartEncoding(
  data: ChartRow[],
  x: string,
  y: string,
  horizontal: boolean,
): VegaEncoding {
  const xIsNumeric = isFiniteNumericField(data, x)
  const yIsNumeric = isFiniteNumericField(data, y)
  const categoryField = xIsNumeric && !yIsNumeric ? y : x
  const valueField = yIsNumeric && !xIsNumeric ? y : x

  if (horizontal) {
    return {
      y: { field: categoryField, type: 'nominal', sort: '-x', axis: { labelAngle: 0 } },
      x: { field: valueField, type: 'quantitative' },
    }
  }

  return {
    x: { field: categoryField, type: 'nominal', sort: '-y', axis: { labelAngle: -45 } },
    y: { field: valueField, type: 'quantitative' },
  }
}

export function inferSequentialXAxisEncoding(data: ChartRow[], field: string) {
  const values = getFieldValues(data, field)
  if (values.length === 0) {
    return { field, type: 'ordinal' as const }
  }

  const allNumbers = values.every((value) => typeof value === 'number' && Number.isFinite(value))
  if (allNumbers) {
    return { field, type: 'quantitative' as const }
  }

  const allTemporal = values.every((value) => {
    if (value instanceof Date) return Number.isFinite(value.getTime())
    if (typeof value === 'string') return parseTemporalString(value) != null
    return false
  })
  if (allTemporal) {
    return { field, type: 'temporal' as const }
  }

  const weekdayValues = values
    .map((value) => canonicalizeKnownToken(value, WEEKDAY_ALIASES, WEEKDAY_ORDER))
    .filter((value): value is string => Boolean(value))
  if (weekdayValues.length === values.length) {
    const present = new Set(weekdayValues)
    return {
      field,
      type: 'ordinal' as const,
      sort: WEEKDAY_ORDER.filter((value) => present.has(value)).map((value) => {
        const original = values.find((entry) => canonicalizeKnownToken(entry, WEEKDAY_ALIASES, WEEKDAY_ORDER) === value)
        return String(original)
      }),
    }
  }

  const monthValues = values
    .map((value) => canonicalizeKnownToken(value, MONTH_ALIASES, MONTH_ORDER))
    .filter((value): value is string => Boolean(value))
  if (monthValues.length === values.length) {
    const present = new Set(monthValues)
    return {
      field,
      type: 'ordinal' as const,
      sort: MONTH_ORDER.filter((value) => present.has(value)).map((value) => {
        const original = values.find((entry) => canonicalizeKnownToken(entry, MONTH_ALIASES, MONTH_ORDER) === value)
        return String(original)
      }),
    }
  }

  return {
    field,
    type: 'ordinal' as const,
    sort: uniqueInEncounterOrder(values),
  }
}

export function normalizeSeriesColorField(colorField: string | undefined, xField: string, yField: string) {
  if (!colorField) return undefined
  const trimmed = colorField.trim()
  if (!trimmed) return undefined
  if (trimmed === xField || trimmed === yField) return undefined
  return trimmed
}

export function canPromoteNumericColorToQuantitative(spec: Record<string, unknown>) {
  const mark = spec.mark
  const markType = typeof mark === 'string'
    ? mark
    : mark && typeof mark === 'object' && !Array.isArray(mark) && typeof (mark as Record<string, unknown>).type === 'string'
      ? String((mark as Record<string, unknown>).type)
      : ''

  return markType !== 'line' && markType !== 'area'
}

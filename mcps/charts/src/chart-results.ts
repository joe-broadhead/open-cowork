import { canPromoteNumericColorToQuantitative, getFieldValues } from './chart-utils.js'

const VEGA_SCHEMA = 'https://vega.github.io/schema/vega-lite/v6.json'
const DATA_REQUIRED_HINT = 'Always include `data`: an inline array of row objects containing every field named by x, y, color, size, source, target, or value.'

export function chartToolDescription(description: string) {
  return `${description} ${DATA_REQUIRED_HINT}`
}

function getInlineValues(spec: Record<string, unknown>) {
  const data = spec.data as Record<string, unknown> | undefined
  return Array.isArray(data?.values) ? data.values : null
}

function getFieldValuesFromSpec(spec: Record<string, unknown>, field: string) {
  const values = getInlineValues(spec)
  if (!values) return []
  return getFieldValues(
    values.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row)),
    field,
  )
}

function isNumericSeries(values: unknown[]) {
  return values.length > 0 && values.every((value) => typeof value === 'number' && Number.isFinite(value))
}

function getDistinctCount(values: unknown[]) {
  return new Set(values.map((value) => String(value))).size
}

function applyLegendPolish(spec: Record<string, unknown>, encoding: Record<string, any>) {
  const color = encoding.color as Record<string, any> | undefined
  if (!color || typeof color.field !== 'string') return

  const values = getFieldValuesFromSpec(spec, color.field)
  if (color.type === 'nominal' && isNumericSeries(values) && canPromoteNumericColorToQuantitative(spec)) {
    color.type = 'quantitative'
    color.scale = { ...(color.scale || {}), scheme: 'plasma' }
  }

  if (color.type === 'quantitative') {
    color.legend = {
      ...(color.legend || {}),
      orient: 'right',
      gradientLength: 180,
      format: color.legend?.format || ',.0f',
    }
    return
  }

  const distinctCount = getDistinctCount(values)
  if (distinctCount >= 8) {
    color.legend = {
      ...(color.legend || {}),
      orient: 'bottom',
      direction: 'horizontal',
      columns: Math.min(4, Math.max(2, Math.ceil(Math.sqrt(distinctCount)))),
      titleLimit: 220,
      labelLimit: 180,
    }
    return
  }

  color.legend = {
    ...(color.legend || {}),
    orient: 'right',
    titleLimit: 220,
    labelLimit: 220,
  }
}

export function vegaResult(spec: Record<string, unknown>, title: string) {
  // Add number formatting to quantitative fields for nicer tooltips and axes.
  const encoding = spec.encoding as Record<string, any> | undefined
  if (encoding) {
    for (const [, enc] of Object.entries(encoding)) {
      if (enc?.type === 'quantitative' && !enc.format) {
        enc.format = ',.2f'
      }
    }
    applyLegendPolish(spec, encoding)
  }
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ type: 'vega-lite', spec: { $schema: VEGA_SCHEMA, ...spec }, title }),
    }],
  }
}

export function rawVegaResult(spec: Record<string, unknown>, title: string) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ type: 'vega', spec, title }),
    }],
  }
}

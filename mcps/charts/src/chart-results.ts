import {
  canPromoteNumericColorToQuantitative,
  dateOnlyTemporalEncoding,
  getFieldValues,
  isDateOnlyField,
} from './chart-utils.js'

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

function applyLegendPolish(rootSpec: Record<string, unknown>, encoding: Record<string, any>) {
  const color = encoding.color as Record<string, any> | undefined
  if (!color || typeof color.field !== 'string') return

  const values = getFieldValuesFromSpec(rootSpec, color.field)
  if (color.type === 'nominal' && isNumericSeries(values) && canPromoteNumericColorToQuantitative(rootSpec)) {
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

function applyDateOnlyTemporalPolish(rootSpec: Record<string, unknown>, enc: Record<string, any>) {
  if (enc.type !== 'temporal' || typeof enc.field !== 'string' || enc.timeUnit) return
  const values = getInlineValues(rootSpec)
  if (!values) return
  const rows = values.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row))
  if (!isDateOnlyField(rows, enc.field)) return

  const polished = dateOnlyTemporalEncoding(enc.field)
  enc.timeUnit = polished.timeUnit
  if (enc.axis !== null) {
    enc.axis = {
      ...(polished.axis as Record<string, unknown>),
      ...(enc.axis && typeof enc.axis === 'object' && !Array.isArray(enc.axis) ? enc.axis : {}),
    }
  }
}

function applyEncodingPolish(rootSpec: Record<string, unknown>, specNode: Record<string, unknown>) {
  const encoding = specNode.encoding as Record<string, any> | undefined
  if (encoding) {
    for (const [, enc] of Object.entries(encoding)) {
      if (enc?.type === 'quantitative' && !enc.format) {
        enc.format = ',.2f'
      }
      if (enc && typeof enc === 'object' && !Array.isArray(enc)) {
        applyDateOnlyTemporalPolish(rootSpec, enc)
      }
    }
    applyLegendPolish(rootSpec, encoding)
  }

  const layers = specNode.layer
  if (Array.isArray(layers)) {
    for (const layer of layers) {
      if (layer && typeof layer === 'object' && !Array.isArray(layer)) {
        applyEncodingPolish(rootSpec, layer as Record<string, unknown>)
      }
    }
  }
}

export function vegaResult(spec: Record<string, unknown>, title: string) {
  // Add number formatting to quantitative fields for nicer tooltips and axes.
  applyEncodingPolish(spec, spec)
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

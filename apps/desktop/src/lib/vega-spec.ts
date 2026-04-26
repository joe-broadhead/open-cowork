export type VegaChartTheme = {
  axis: string
  title: string
  grid: string
  domain: string
  accent: string
  green: string
  amber: string
  red: string
  info: string
  muted: string
  secondary: string
}

export function isFullVegaSpec(spec: Record<string, unknown>): boolean {
  const schema = typeof spec?.$schema === 'string' ? spec.$schema : ''
  return schema.includes('/vega/v') && !schema.includes('/vega-lite/')
}

export function normalizeVegaSpecSchema(spec: Record<string, unknown>): Record<string, unknown> {
  const schema = typeof spec?.$schema === 'string' ? spec.$schema : ''
  if (!schema.includes('/vega-lite/')) return spec

  const normalizedSchema = schema.replace(/\/vega-lite\/v\d+(?:\.\d+)?\.json$/, '/vega-lite/v6.json')
  if (normalizedSchema === schema) return spec

  return {
    ...spec,
    $schema: normalizedSchema,
  }
}

function isResponsiveVegaLiteCandidate(spec: Record<string, unknown>) {
  if (isFullVegaSpec(spec)) return false
  if ('facet' in spec || 'repeat' in spec || 'concat' in spec || 'hconcat' in spec || 'vconcat' in spec) {
    return false
  }
  return true
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function getDiscreteValueCount(spec: Record<string, unknown>, channel: string) {
  const data = asRecord(spec.data)
  const values = Array.isArray(data?.values) ? data.values : null
  const encoding = asRecord(spec.encoding)
  const field = asRecord(encoding?.[channel])?.field

  if (!values || typeof field !== 'string') return null

  const unique = new Set<string>()
  for (const row of values) {
    if (!row || typeof row !== 'object') continue
    const value = (row as Record<string, unknown>)[field]
    if (value == null) continue
    unique.add(String(value))
  }

  return unique.size
}

function getMarkType(spec: Record<string, unknown>) {
  const mark = spec.mark
  if (typeof mark === 'string') return mark
  const markRecord = asRecord(mark)
  return typeof markRecord?.type === 'string' ? markRecord.type : null
}

function mergeNestedRecord(target: Record<string, unknown>, key: string, patch: Record<string, unknown>) {
  const current = asRecord(target[key])
  target[key] = {
    ...(current || {}),
    ...patch,
  }
}

function buildSharedThemeConfig(theme: VegaChartTheme) {
  return {
    axis: {
      labelColor: theme.axis,
      titleColor: theme.axis,
      gridColor: theme.grid,
      domainColor: theme.domain,
      labelFontSize: 11,
      titleFontSize: 12,
      labelLimit: 260,
      titleLimit: 220,
    },
    legend: {
      labelColor: theme.axis,
      titleColor: theme.axis,
      labelFontSize: 11,
      titleFontSize: 12,
      labelLimit: 260,
      titleLimit: 220,
      symbolSize: 110,
      padding: 12,
    },
    title: { color: theme.title, fontSize: 14, fontWeight: 600, anchor: 'start', offset: 12 },
    view: { stroke: 'transparent' },
    mark: { color: theme.accent },
    range: {
      category: [
        theme.accent,
        theme.green,
        theme.amber,
        theme.red,
        theme.info,
        theme.secondary,
        theme.muted,
        theme.accent,
        theme.green,
        theme.amber,
      ],
    },
  }
}

export function applyVegaTheme(spec: Record<string, unknown>, theme: VegaChartTheme): Record<string, unknown> {
  const normalizedSpec = normalizeVegaSpecSchema(spec)
  const fullVegaSpec = isFullVegaSpec(normalizedSpec)

  if (fullVegaSpec) {
    return {
      ...normalizedSpec,
      background: 'transparent',
      config: {
        ...(typeof normalizedSpec.config === 'object' && normalizedSpec.config ? normalizedSpec.config : {}),
        ...buildSharedThemeConfig(theme),
      },
    }
  }

  return {
    ...normalizedSpec,
    background: 'transparent',
    config: {
      ...(typeof normalizedSpec.config === 'object' && normalizedSpec.config ? normalizedSpec.config : {}),
      ...buildSharedThemeConfig(theme),
    },
  }
}

export function makeInteractiveVegaSpecResponsive(spec: Record<string, unknown>): Record<string, unknown> {
  const normalizedSpec = normalizeVegaSpecSchema(spec)

  // Full Vega specs (e.g. the sankey MCP output) do not support the
  // encoding-level responsive tweaks below, but they still benefit from
  // having the chart width bound to the iframe container. Without this,
  // the Vega `width` signal stays at the spec's baked-in number, which
  // makes text-mark `limit` expressions clip node labels when the iframe
  // is wider than the spec's default (see sankey.ts:310).
  if (isFullVegaSpec(normalizedSpec)) {
    return {
      ...normalizedSpec,
      width: 'container',
      autosize: {
        ...(typeof normalizedSpec.autosize === 'object' && normalizedSpec.autosize ? normalizedSpec.autosize : {}),
        type: 'fit-x',
        contains: 'padding',
        resize: true,
      },
    }
  }

  if (!isResponsiveVegaLiteCandidate(normalizedSpec)) {
    return normalizedSpec
  }

  const responsiveSpec: Record<string, unknown> = {
    ...normalizedSpec,
    width: 'container',
    autosize: {
      ...(typeof normalizedSpec.autosize === 'object' && normalizedSpec.autosize ? normalizedSpec.autosize : {}),
      type: 'fit-x',
      contains: 'padding',
      resize: true,
    },
  }

  const encoding = asRecord(responsiveSpec.encoding)
  const markType = getMarkType(responsiveSpec)
  const hasHorizontalBars = markType === 'bar'
    && asRecord(encoding?.x)?.type === 'quantitative'
    && asRecord(encoding?.y)?.type === 'nominal'

  if (encoding) {
    if (asRecord(encoding.color)?.type === 'nominal') {
      mergeNestedRecord(encoding, 'color', {
        legend: {
          ...(asRecord(asRecord(encoding.color)?.legend) || {}),
          orient: 'right',
          direction: 'vertical',
        },
      })
    }

    if (hasHorizontalBars) {
      const categoryCount = getDiscreteValueCount(responsiveSpec, 'y')
      const derivedHeight = categoryCount ? Math.min(720, Math.max(320, categoryCount * 44 + 80)) : null
      if (typeof derivedHeight === 'number') {
        responsiveSpec.height = derivedHeight
      }
      mergeNestedRecord(encoding, 'y', {
        axis: {
          ...(asRecord(asRecord(encoding.y)?.axis) || {}),
          labelLimit: 320,
          labelPadding: 10,
          titlePadding: 12,
        },
      })
    }
  }

  if (markType === 'arc' && encoding) {
    mergeNestedRecord(encoding, 'color', {
      legend: {
        ...(asRecord(asRecord(encoding.color)?.legend) || {}),
        orient: 'right',
        direction: 'vertical',
        labelLimit: 280,
        symbolType: 'circle',
      },
    })
    if (typeof responsiveSpec.height !== 'number') {
      responsiveSpec.height = 420
    }
  }

  return responsiveSpec
}

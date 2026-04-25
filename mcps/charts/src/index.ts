import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { buildSankeySpec } from './sankey.js'
import { canPromoteNumericColorToQuantitative, getFieldValues, inferSequentialXAxisEncoding, normalizeSeriesColorField } from './chart-utils.js'
import { chartDataSchema, vegaLiteSpecSchema } from './schemas.js'

const server = new McpServer({
  name: 'charts',
  version: '1.0.0',
})

const VEGA_SCHEMA = 'https://vega.github.io/schema/vega-lite/v6.json'

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

function vegaResult(spec: Record<string, unknown>, title: string) {
  // Add number formatting to quantitative fields for nicer tooltips and axes
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

function rawVegaResult(spec: Record<string, unknown>, title: string) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ type: 'vega', spec, title }),
    }],
  }
}

// ─── BAR CHART ───

server.tool(
  'bar_chart',
  'Create an interactive bar chart. Great for comparing categories.',
  {
    data: chartDataSchema,
    x: z.string().describe('Field for x-axis (categories)'),
    y: z.string().describe('Field for y-axis (values)'),
    color: z.string().optional().describe('Field for color grouping'),
    title: z.string().optional().default('Bar Chart'),
    horizontal: z.boolean().optional().default(false).describe('Horizontal bars'),
    width: z.number().optional().default(600),
    height: z.number().optional().default(400),
  },
  async ({ data, x, y, color, title, horizontal, width, height }) => {
    const spec: Record<string, unknown> = {
      width, height, title,
      data: { values: data },
      mark: { type: 'bar', tooltip: true },
      encoding: {
        [horizontal ? 'y' : 'x']: { field: x, type: 'nominal', sort: '-y', axis: { labelAngle: horizontal ? 0 : -45 } },
        [horizontal ? 'x' : 'y']: { field: y, type: 'quantitative' },
        ...(color ? { color: { field: color, type: 'nominal' } } : {}),
      },
    }
    return vegaResult(spec, title!)
  },
)

// ─── LINE CHART ───

server.tool(
  'line_chart',
  'Create an interactive line chart. Great for time series and trends.',
  {
    data: chartDataSchema,
    x: z.string().describe('Field for x-axis (usually time/date)'),
    y: z.string().describe('Field for y-axis (values)'),
    color: z.string().optional().describe('Field for multiple series'),
    title: z.string().optional().default('Line Chart'),
    width: z.number().optional().default(600),
    height: z.number().optional().default(400),
  },
  async ({ data, x, y, color, title, width, height }) => {
    const normalizedColor = normalizeSeriesColorField(color, x, y)
    const spec: Record<string, unknown> = {
      width, height, title,
      data: { values: data },
      mark: { type: 'line', point: true, tooltip: true },
      encoding: {
        x: inferSequentialXAxisEncoding(data, x),
        y: { field: y, type: 'quantitative' },
        ...(normalizedColor ? { color: { field: normalizedColor, type: 'nominal' } } : {}),
      },
    }
    return vegaResult(spec, title!)
  },
)

// ─── AREA CHART ───

server.tool(
  'area_chart',
  'Create a stacked area chart. Great for showing composition over time.',
  {
    data: chartDataSchema,
    x: z.string().describe('Field for x-axis'),
    y: z.string().describe('Field for y-axis'),
    color: z.string().optional().describe('Field for stacking'),
    title: z.string().optional().default('Area Chart'),
    width: z.number().optional().default(600),
    height: z.number().optional().default(400),
  },
  async ({ data, x, y, color, title, width, height }) => {
    const normalizedColor = normalizeSeriesColorField(color, x, y)
    const spec: Record<string, unknown> = {
      width, height, title,
      data: { values: data },
      mark: { type: 'area', tooltip: true, opacity: 0.7 },
      encoding: {
        x: inferSequentialXAxisEncoding(data, x),
        y: { field: y, type: 'quantitative', stack: 'zero' },
        ...(normalizedColor ? { color: { field: normalizedColor, type: 'nominal' } } : {}),
      },
    }
    return vegaResult(spec, title!)
  },
)

// ─── SCATTER PLOT ───

server.tool(
  'scatter_plot',
  'Create an interactive scatter plot. Great for showing correlations.',
  {
    data: chartDataSchema,
    x: z.string().describe('Field for x-axis'),
    y: z.string().describe('Field for y-axis'),
    color: z.string().optional().describe('Field for color grouping'),
    size: z.string().optional().describe('Field for bubble size'),
    title: z.string().optional().default('Scatter Plot'),
    width: z.number().optional().default(600),
    height: z.number().optional().default(400),
  },
  async ({ data, x, y, color, size, title, width, height }) => {
    const spec: Record<string, unknown> = {
      width, height, title,
      data: { values: data },
      mark: { type: 'point', tooltip: true, filled: true, opacity: 0.7 },
      encoding: {
        x: { field: x, type: 'quantitative' },
        y: { field: y, type: 'quantitative' },
        ...(color ? { color: { field: color, type: 'nominal' } } : {}),
        ...(size ? { size: { field: size, type: 'quantitative' } } : {}),
      },
    }
    return vegaResult(spec, title!)
  },
)

// ─── PIE / DONUT CHART ───

server.tool(
  'pie_chart',
  'Create a pie or donut chart. Great for showing proportions.',
  {
    data: chartDataSchema,
    category: z.string().describe('Field for categories/slices'),
    value: z.string().describe('Field for values'),
    title: z.string().optional().default('Pie Chart'),
    donut: z.boolean().optional().default(false).describe('Make it a donut chart'),
    width: z.number().optional().default(400),
    height: z.number().optional().default(400),
  },
  async ({ data, category, value, title, donut, width, height }) => {
    const spec: Record<string, unknown> = {
      width, height, title,
      data: { values: data },
      mark: { type: 'arc', tooltip: true, ...(donut ? { innerRadius: 80 } : {}) },
      encoding: {
        theta: { field: value, type: 'quantitative', stack: true },
        color: { field: category, type: 'nominal' },
      },
    }
    return vegaResult(spec, title!)
  },
)

// ─── HISTOGRAM ───

server.tool(
  'histogram',
  'Create a histogram showing data distribution.',
  {
    data: chartDataSchema,
    field: z.string().describe('Field to bin'),
    bins: z.number().optional().default(20).describe('Number of bins'),
    title: z.string().optional().default('Histogram'),
    width: z.number().optional().default(600),
    height: z.number().optional().default(400),
  },
  async ({ data, field, bins, title, width, height }) => {
    const spec: Record<string, unknown> = {
      width, height, title,
      data: { values: data },
      mark: { type: 'bar', tooltip: true },
      encoding: {
        x: { field, type: 'quantitative', bin: { maxbins: bins } },
        y: { aggregate: 'count', type: 'quantitative' },
      },
    }
    return vegaResult(spec, title!)
  },
)

// ─── HEATMAP ───

server.tool(
  'heatmap',
  'Create a heatmap showing values across two dimensions.',
  {
    data: chartDataSchema,
    x: z.string().describe('Field for columns'),
    y: z.string().describe('Field for rows'),
    value: z.string().describe('Field for cell values (color intensity)'),
    title: z.string().optional().default('Heatmap'),
    width: z.number().optional().default(600),
    height: z.number().optional().default(400),
  },
  async ({ data, x, y, value, title, width, height }) => {
    const spec: Record<string, unknown> = {
      width, height, title,
      data: { values: data },
      mark: { type: 'rect', tooltip: true },
      encoding: {
        x: { field: x, type: 'nominal' },
        y: { field: y, type: 'nominal' },
        color: { field: value, type: 'quantitative', scale: { scheme: 'blues' } },
      },
    }
    return vegaResult(spec, title!)
  },
)

// ─── BOX PLOT ───

server.tool(
  'boxplot',
  'Create a box plot showing distribution statistics.',
  {
    data: chartDataSchema,
    category: z.string().describe('Field for categories'),
    value: z.string().describe('Field for values'),
    title: z.string().optional().default('Box Plot'),
    width: z.number().optional().default(600),
    height: z.number().optional().default(400),
  },
  async ({ data, category, value, title, width, height }) => {
    const spec: Record<string, unknown> = {
      width, height, title,
      data: { values: data },
      mark: { type: 'boxplot', tooltip: true },
      encoding: {
        x: { field: category, type: 'nominal' },
        y: { field: value, type: 'quantitative' },
      },
    }
    return vegaResult(spec, title!)
  },
)

// ─── MAP (Geographic) ───

server.tool(
  'map',
  'Create a geographic map with data points. Data must include latitude and longitude fields.',
  {
    data: chartDataSchema,
    latitude: z.string().describe('Field for latitude'),
    longitude: z.string().describe('Field for longitude'),
    size: z.string().optional().describe('Field for point size'),
    color: z.string().optional().describe('Field for point color'),
    title: z.string().optional().default('Map'),
    width: z.number().optional().default(700),
    height: z.number().optional().default(500),
  },
  async ({ data, latitude, longitude, size, color, title, width, height }) => {
    const spec: Record<string, unknown> = {
      width, height, title,
      projection: { type: 'equalEarth' },
      layer: [
        {
          data: { sphere: true },
          mark: { type: 'geoshape', fill: '#2a2d3f', stroke: '#61657d', strokeWidth: 1.2 },
        },
        {
          data: { graticule: { step: [20, 20] } },
          mark: { type: 'geoshape', stroke: '#50556d', strokeWidth: 0.8, opacity: 0.85 },
        },
        {
          data: { values: data },
          mark: { type: 'circle', tooltip: true, opacity: 0.8, stroke: '#ffffff', strokeWidth: 0.8 },
          encoding: {
            latitude: { field: latitude, type: 'quantitative' },
            longitude: { field: longitude, type: 'quantitative' },
            ...(size ? { size: { field: size, type: 'quantitative' } } : { size: { value: 50 } }),
            ...(color ? { color: { field: color, type: 'nominal' } } : { color: { value: '#4f8ff7' } }),
          },
        },
      ],
    }
    return vegaResult(spec, title!)
  },
)

// ─── FUNNEL CHART ───

server.tool(
  'funnel_chart',
  'Create a funnel chart showing stage dropoff across an ordered process.',
  {
    data: chartDataSchema,
    stage: z.string().describe('Field containing the funnel stage label'),
    value: z.string().describe('Field containing the stage value'),
    title: z.string().optional().default('Funnel Chart'),
    width: z.number().optional().default(700),
    height: z.number().optional().default(420),
  },
  async ({ data, stage, value, title, width, height }) => {
    const spec: Record<string, unknown> = {
      width,
      height,
      title,
      data: { values: data },
      layer: [
        {
          mark: { type: 'bar', tooltip: true, cornerRadiusEnd: 4 },
          encoding: {
            y: { field: stage, type: 'nominal', sort: null, axis: { labelLimit: 220 } },
            x: { field: value, type: 'quantitative' },
            color: { field: stage, type: 'nominal', legend: null },
          },
        },
        {
          mark: { type: 'text', align: 'left', baseline: 'middle', dx: 6 },
          encoding: {
            y: { field: stage, type: 'nominal', sort: null },
            x: { field: value, type: 'quantitative' },
            text: { field: value, type: 'quantitative', format: ',.2f' },
          },
        },
      ],
    }
    return vegaResult(spec, title!)
  },
)

// ─── WATERFALL CHART ───

server.tool(
  'waterfall_chart',
  'Create a waterfall chart showing how sequential increases and decreases build to a total.',
  {
    data: chartDataSchema,
    category: z.string().describe('Field containing the ordered category or step'),
    value: z.string().describe('Field containing the signed change value for each step'),
    title: z.string().optional().default('Waterfall Chart'),
    width: z.number().optional().default(760),
    height: z.number().optional().default(420),
  },
  async ({ data, category, value, title, width, height }) => {
    const spec: Record<string, unknown> = {
      width,
      height,
      title,
      data: { values: data },
      transform: [
        { window: [{ op: 'sum', field: value, as: '__running_total' }] },
        { calculate: `datum.__running_total - datum["${value}"]`, as: '__previous_total' },
        { calculate: 'min(datum.__previous_total, datum.__running_total)', as: '__start' },
        { calculate: 'max(datum.__previous_total, datum.__running_total)', as: '__end' },
        { calculate: `datum["${value}"] >= 0 ? "Increase" : "Decrease"`, as: '__direction' },
      ],
      layer: [
        {
          mark: { type: 'bar', tooltip: true, cornerRadius: 3 },
          encoding: {
            x: { field: category, type: 'nominal', sort: null, axis: { labelAngle: -30 } },
            y: { field: '__start', type: 'quantitative', title: null },
            y2: { field: '__end' },
            color: {
              field: '__direction',
              type: 'nominal',
              scale: {
                domain: ['Increase', 'Decrease'],
                range: ['#6fcf97', '#eb5757'],
              },
            },
          },
        },
        {
          mark: { type: 'text', baseline: 'bottom', dy: -4 },
          encoding: {
            x: { field: category, type: 'nominal', sort: null },
            y: { field: '__end', type: 'quantitative' },
            text: { field: value, type: 'quantitative', format: '+,.2f' },
          },
        },
      ],
    }
    return vegaResult(spec, title!)
  },
)

// ─── BUMP CHART ───

server.tool(
  'bump_chart',
  'Create a bump chart showing how ranks change across ordered periods.',
  {
    data: chartDataSchema,
    x: z.string().describe('Field for the ordered period or stage'),
    rank: z.string().describe('Field containing the rank value'),
    series: z.string().describe('Field identifying each ranked series'),
    title: z.string().optional().default('Bump Chart'),
    width: z.number().optional().default(760),
    height: z.number().optional().default(420),
  },
  async ({ data, x, rank, series, title, width, height }) => {
    const spec: Record<string, unknown> = {
      width,
      height,
      title,
      data: { values: data },
      mark: { type: 'line', point: true, tooltip: true, strokeWidth: 3 },
      encoding: {
        x: { field: x, type: 'ordinal' },
        y: { field: rank, type: 'quantitative', scale: { reverse: true }, axis: { tickMinStep: 1 } },
        color: { field: series, type: 'nominal' },
      },
    }
    return vegaResult(spec, title!)
  },
)

// ─── STREAMGRAPH ───

server.tool(
  'streamgraph',
  'Create a streamgraph showing how composition changes across time with centered stacked areas.',
  {
    data: chartDataSchema,
    x: z.string().describe('Field for the ordered time or sequence axis'),
    y: z.string().describe('Field containing the numeric value'),
    series: z.string().describe('Field identifying each stacked series'),
    title: z.string().optional().default('Streamgraph'),
    width: z.number().optional().default(760),
    height: z.number().optional().default(420),
  },
  async ({ data, x, y, series, title, width, height }) => {
    const spec: Record<string, unknown> = {
      width,
      height,
      title,
      data: { values: data },
      mark: { type: 'area', tooltip: true, interpolate: 'monotone', opacity: 0.9 },
      encoding: {
        x: { field: x, type: 'temporal' },
        y: { field: y, type: 'quantitative', stack: 'center' },
        color: { field: series, type: 'nominal' },
      },
    }
    return vegaResult(spec, title!)
  },
)

// ─── CALENDAR HEATMAP ───

server.tool(
  'calendar_heatmap',
  'Create a calendar heatmap showing daily intensity across weeks and years.',
  {
    data: chartDataSchema,
    date: z.string().describe('Field containing the date value'),
    value: z.string().describe('Field containing the daily value'),
    title: z.string().optional().default('Calendar Heatmap'),
    width: z.number().optional().default(900),
    height: z.number().optional().default(120),
  },
  async ({ data, date, value, title, width, height }) => {
    const spec: Record<string, unknown> = {
      width,
      height,
      title,
      data: { values: data },
      transform: [
        { calculate: `toDate(datum["${date}"])`, as: '__date' },
        { calculate: `timeFormat(datum.__date, '%Y')`, as: '__year' },
        { calculate: `timeFormat(datum.__date, '%U')`, as: '__week' },
        { calculate: `timeFormat(datum.__date, '%a')`, as: '__day' },
      ],
      mark: { type: 'rect', tooltip: true, cornerRadius: 2 },
      encoding: {
        row: { field: '__year', type: 'ordinal', header: { labelAngle: 0 } },
        x: { field: '__week', type: 'ordinal', title: 'Week' },
        y: {
          field: '__day',
          type: 'ordinal',
          sort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
          title: null,
        },
        color: { field: value, type: 'quantitative', scale: { scheme: 'blues' } },
        tooltip: [
          { field: '__date', type: 'temporal', title: 'Date' },
          { field: value, type: 'quantitative', title: 'Value', format: ',.2f' },
        ],
      },
    }
    return vegaResult(spec, title!)
  },
)

// ─── BULLET CHART ───

server.tool(
  'bullet_chart',
  'Create a bullet chart comparing actuals against a target, with optional qualitative ranges.',
  {
    data: chartDataSchema,
    category: z.string().describe('Field identifying the category or measure'),
    actual: z.string().describe('Field containing the actual value'),
    target: z.string().describe('Field containing the target value'),
    rangeLow: z.string().optional().describe('Optional field for the low qualitative range upper bound'),
    rangeMid: z.string().optional().describe('Optional field for the middle qualitative range upper bound'),
    rangeHigh: z.string().optional().describe('Optional field for the high qualitative range upper bound'),
    title: z.string().optional().default('Bullet Chart'),
    width: z.number().optional().default(760),
    height: z.number().optional().default(360),
  },
  async ({ data, category, actual, target, rangeLow, rangeMid, rangeHigh, title, width, height }) => {
    const layers: Array<Record<string, unknown>> = []

    const rangeFields = [
      { field: rangeHigh, color: '#d9d9d9' },
      { field: rangeMid, color: '#c2c2c2' },
      { field: rangeLow, color: '#aaaaaa' },
    ].filter((entry) => Boolean(entry.field))

    for (const range of rangeFields) {
      layers.push({
        mark: { type: 'bar', tooltip: true, size: 26, opacity: 0.45, color: range.color },
        encoding: {
          y: { field: category, type: 'nominal', sort: null },
          x: { field: range.field, type: 'quantitative' },
        },
      })
    }

    layers.push(
      {
        mark: { type: 'bar', tooltip: true, size: 12, color: '#5b8def' },
        encoding: {
          y: { field: category, type: 'nominal', sort: null },
          x: { field: actual, type: 'quantitative' },
        },
      },
      {
        mark: { type: 'tick', color: '#1f1f1f', size: 28 },
        encoding: {
          y: { field: category, type: 'nominal', sort: null },
          x: { field: target, type: 'quantitative' },
        },
      },
    )

    const spec: Record<string, unknown> = {
      width,
      height,
      title,
      data: { values: data },
      layer: layers,
    }
    return vegaResult(spec, title!)
  },
)

// ─── CANDLESTICK CHART ───

server.tool(
  'candlestick_chart',
  'Create a candlestick chart showing open, high, low, and close values across time.',
  {
    data: chartDataSchema,
    x: z.string().describe('Field for the time axis'),
    open: z.string().describe('Field containing the open value'),
    high: z.string().describe('Field containing the high value'),
    low: z.string().describe('Field containing the low value'),
    close: z.string().describe('Field containing the close value'),
    title: z.string().optional().default('Candlestick Chart'),
    width: z.number().optional().default(760),
    height: z.number().optional().default(420),
  },
  async ({ data, x, open, high, low, close, title, width, height }) => {
    const spec: Record<string, unknown> = {
      width,
      height,
      title,
      data: { values: data },
      transform: [
        { calculate: `datum["${close}"] >= datum["${open}"] ? "Up" : "Down"`, as: '__movement' },
      ],
      layer: [
        {
          mark: { type: 'rule', tooltip: true, strokeWidth: 1.5 },
          encoding: {
            x: { field: x, type: 'temporal' },
            y: { field: low, type: 'quantitative' },
            y2: { field: high },
            color: {
              field: '__movement',
              type: 'nominal',
              scale: { domain: ['Up', 'Down'], range: ['#6fcf97', '#eb5757'] },
              legend: null,
            },
          },
        },
        {
          mark: { type: 'bar', tooltip: true, size: 10 },
          encoding: {
            x: { field: x, type: 'temporal' },
            y: { field: open, type: 'quantitative' },
            y2: { field: close },
            color: {
              field: '__movement',
              type: 'nominal',
              scale: { domain: ['Up', 'Down'], range: ['#6fcf97', '#eb5757'] },
            },
          },
        },
      ],
    }
    return vegaResult(spec, title!)
  },
)

// ─── SANKEY ───

server.tool(
  'sankey',
  'Create a Sankey diagram showing flow volume between stages or entities.',
  {
    data: chartDataSchema,
    source: z.string().describe('Field containing the source node label'),
    target: z.string().describe('Field containing the target node label'),
    value: z.string().describe('Field containing the flow value'),
    title: z.string().optional().default('Sankey Diagram'),
    width: z.number().optional().default(900),
    height: z.number().optional().default(480),
    nodeWidth: z.number().optional().default(18).describe('Width of each node block'),
    nodePadding: z.number().optional().default(20).describe('Vertical padding between nodes in the same column'),
  },
  async ({ data, source, target, value, title, width, height, nodeWidth, nodePadding }) => {
    const spec = buildSankeySpec({
      data,
      source,
      target,
      value,
      title: title!,
      width,
      height,
      nodeWidth,
      nodePadding,
    })
    return rawVegaResult(spec, title!)
  },
)

// ─── MERMAID DIAGRAM ───

server.tool(
  'mermaid',
  'Create a Mermaid diagram (flowchart, sequence, gantt, etc.). Returns Mermaid syntax for the UI to render.',
  {
    diagram: z.string().describe('Mermaid diagram syntax (e.g. "graph TD\\n  A-->B\\n  B-->C")'),
    title: z.string().optional().default('Diagram'),
  },
  async ({ diagram, title }) => {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ type: 'mermaid', diagram, title }),
      }],
    }
  },
)

// ─── CUSTOM VEGA-LITE SPEC ───

server.tool(
  'custom_spec',
  'Render a custom Vega-Lite specification. Use for advanced charts not covered by other tools. See https://vega.github.io/vega-lite/examples/',
  {
    spec: vegaLiteSpecSchema,
    title: z.string().optional().default('Custom Chart'),
  },
  async ({ spec, title }) => {
    return vegaResult(spec, title!)
  },
)

console.error('[charts-mcp] Server started')
const transport = new StdioServerTransport()
server.connect(transport)

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { chartToolDescription, rawVegaResult, vegaResult } from './chart-results.js'
import { buildSankeySpec } from './sankey.js'
import { chartDataSchema, chartDimensionSchema, chartFieldNameSchema, vegaLiteSpecSchema } from './schemas.js'

// User-supplied field names are interpolated into Vega `calculate` expression strings as
// `datum["<field>"]`. Escape backslashes + double-quotes so a crafted field name (e.g.
// `x"] ? (1) : (0`) cannot break out of the string literal and inject an arbitrary expression.
function vegaField(name: string) {
  return name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function registerAdvancedChartTools(server: McpServer) {
  server.tool(
    'funnel_chart',
    chartToolDescription('Create a funnel chart showing stage dropoff across an ordered process.'),
    {
      data: chartDataSchema,
      stage: chartFieldNameSchema.describe('Field containing the funnel stage label'),
      value: chartFieldNameSchema.describe('Field containing the stage value'),
      title: z.string().optional().default('Funnel Chart'),
      width: chartDimensionSchema.optional().default(700),
      height: chartDimensionSchema.optional().default(420),
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

  server.tool(
    'waterfall_chart',
    chartToolDescription('Create a waterfall chart showing how sequential increases and decreases build to a total.'),
    {
      data: chartDataSchema,
      category: chartFieldNameSchema.describe('Field containing the ordered category or step'),
      value: chartFieldNameSchema.describe('Field containing the signed change value for each step'),
      title: z.string().optional().default('Waterfall Chart'),
      width: chartDimensionSchema.optional().default(760),
      height: chartDimensionSchema.optional().default(420),
    },
    async ({ data, category, value, title, width, height }) => {
      const spec: Record<string, unknown> = {
        width,
        height,
        title,
        data: { values: data },
        transform: [
          { window: [{ op: 'sum', field: value, as: '__running_total' }] },
          { calculate: `datum.__running_total - datum["${vegaField(value)}"]`, as: '__previous_total' },
          { calculate: 'min(datum.__previous_total, datum.__running_total)', as: '__start' },
          { calculate: 'max(datum.__previous_total, datum.__running_total)', as: '__end' },
          { calculate: `datum["${vegaField(value)}"] >= 0 ? "Increase" : "Decrease"`, as: '__direction' },
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

  server.tool(
    'bump_chart',
    chartToolDescription('Create a bump chart showing how ranks change across ordered periods.'),
    {
      data: chartDataSchema,
      x: chartFieldNameSchema.describe('Field for the ordered period or stage'),
      rank: chartFieldNameSchema.describe('Field containing the rank value'),
      series: chartFieldNameSchema.describe('Field identifying each ranked series'),
      title: z.string().optional().default('Bump Chart'),
      width: chartDimensionSchema.optional().default(760),
      height: chartDimensionSchema.optional().default(420),
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

  server.tool(
    'streamgraph',
    chartToolDescription('Create a streamgraph showing how composition changes across time with centered stacked areas.'),
    {
      data: chartDataSchema,
      x: chartFieldNameSchema.describe('Field for the ordered time or sequence axis'),
      y: chartFieldNameSchema.describe('Field containing the numeric value'),
      series: chartFieldNameSchema.describe('Field identifying each stacked series'),
      title: z.string().optional().default('Streamgraph'),
      width: chartDimensionSchema.optional().default(760),
      height: chartDimensionSchema.optional().default(420),
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

  server.tool(
    'calendar_heatmap',
    chartToolDescription('Create a calendar heatmap showing daily intensity across weeks and years.'),
    {
      data: chartDataSchema,
      date: chartFieldNameSchema.describe('Field containing the date value'),
      value: chartFieldNameSchema.describe('Field containing the daily value'),
      title: z.string().optional().default('Calendar Heatmap'),
      width: chartDimensionSchema.optional().default(900),
      height: chartDimensionSchema.optional().default(120),
    },
    async ({ data, date, value, title, width, height }) => {
      const spec: Record<string, unknown> = {
        width,
        height,
        title,
        data: { values: data },
        transform: [
          { calculate: `toDate(datum["${vegaField(date)}"])`, as: '__date' },
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

  server.tool(
    'bullet_chart',
    chartToolDescription('Create a bullet chart comparing actuals against a target, with optional qualitative ranges.'),
    {
      data: chartDataSchema,
      category: chartFieldNameSchema.describe('Field identifying the category or measure'),
      actual: chartFieldNameSchema.describe('Field containing the actual value'),
      target: chartFieldNameSchema.describe('Field containing the target value'),
      rangeLow: chartFieldNameSchema.optional().describe('Optional field for the low qualitative range upper bound'),
      rangeMid: chartFieldNameSchema.optional().describe('Optional field for the middle qualitative range upper bound'),
      rangeHigh: chartFieldNameSchema.optional().describe('Optional field for the high qualitative range upper bound'),
      title: z.string().optional().default('Bullet Chart'),
      width: chartDimensionSchema.optional().default(760),
      height: chartDimensionSchema.optional().default(360),
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

  server.tool(
    'candlestick_chart',
    chartToolDescription('Create a candlestick chart showing open, high, low, and close values across time.'),
    {
      data: chartDataSchema,
      x: chartFieldNameSchema.describe('Field for the time axis'),
      open: chartFieldNameSchema.describe('Field containing the open value'),
      high: chartFieldNameSchema.describe('Field containing the high value'),
      low: chartFieldNameSchema.describe('Field containing the low value'),
      close: chartFieldNameSchema.describe('Field containing the close value'),
      title: z.string().optional().default('Candlestick Chart'),
      width: chartDimensionSchema.optional().default(760),
      height: chartDimensionSchema.optional().default(420),
    },
    async ({ data, x, open, high, low, close, title, width, height }) => {
      const spec: Record<string, unknown> = {
        width,
        height,
        title,
        data: { values: data },
        transform: [
          { calculate: `datum["${vegaField(close)}"] >= datum["${vegaField(open)}"] ? "Up" : "Down"`, as: '__movement' },
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

  server.tool(
    'sankey',
    chartToolDescription('Create a Sankey diagram showing flow volume between stages or entities.'),
    {
      data: chartDataSchema,
      source: chartFieldNameSchema.describe('Field containing the source node label'),
      target: chartFieldNameSchema.describe('Field containing the target node label'),
      value: chartFieldNameSchema.describe('Field containing the flow value'),
      title: z.string().optional().default('Sankey Diagram'),
      width: chartDimensionSchema.optional().default(900),
      height: chartDimensionSchema.optional().default(480),
      nodeWidth: chartDimensionSchema.optional().default(18).describe('Width of each node block'),
      nodePadding: chartDimensionSchema.optional().default(20).describe('Vertical padding between nodes in the same column'),
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

  server.tool(
    'mermaid',
    'Create a Mermaid diagram (flowchart, sequence, gantt, etc.). Returns Mermaid syntax for the UI to render.',
    {
      diagram: z.string().describe('Mermaid diagram syntax (e.g. "graph TD\\n  A-->B\\n  B-->C")'),
      title: z.string().optional().default('Diagram'),
    },
    async ({ diagram, title }) => ({
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ type: 'mermaid', diagram, title }),
      }],
    }),
  )

  server.tool(
    'custom_spec',
    'Render a custom Vega-Lite specification. Use for advanced charts not covered by other tools. See https://vega.github.io/vega-lite/examples/',
    {
      spec: vegaLiteSpecSchema,
      title: z.string().optional().default('Custom Chart'),
    },
    async ({ spec, title }) => vegaResult(spec, title!),
  )
}

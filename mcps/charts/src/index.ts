import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({
  name: 'charts',
  version: '1.0.0',
})

const VEGA_SCHEMA = 'https://vega.github.io/schema/vega-lite/v5.json'

function vegaResult(spec: Record<string, unknown>, title: string) {
  // Add number formatting to quantitative fields for nicer tooltips and axes
  const encoding = spec.encoding as Record<string, any> | undefined
  if (encoding) {
    for (const [, enc] of Object.entries(encoding)) {
      if (enc?.type === 'quantitative' && !enc.format) {
        enc.format = ',.2f'
      }
    }
  }
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ type: 'vega-lite', spec: { $schema: VEGA_SCHEMA, ...spec }, title }),
    }],
  }
}

const dataSchema = z.array(z.record(z.unknown())).describe('Array of data objects')

// ─── BAR CHART ───

server.tool(
  'bar_chart',
  'Create an interactive bar chart. Great for comparing categories.',
  {
    data: dataSchema,
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
    data: dataSchema,
    x: z.string().describe('Field for x-axis (usually time/date)'),
    y: z.string().describe('Field for y-axis (values)'),
    color: z.string().optional().describe('Field for multiple series'),
    title: z.string().optional().default('Line Chart'),
    width: z.number().optional().default(600),
    height: z.number().optional().default(400),
  },
  async ({ data, x, y, color, title, width, height }) => {
    const spec: Record<string, unknown> = {
      width, height, title,
      data: { values: data },
      mark: { type: 'line', point: true, tooltip: true },
      encoding: {
        x: { field: x, type: 'temporal' },
        y: { field: y, type: 'quantitative' },
        ...(color ? { color: { field: color, type: 'nominal' } } : {}),
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
    data: dataSchema,
    x: z.string().describe('Field for x-axis'),
    y: z.string().describe('Field for y-axis'),
    color: z.string().optional().describe('Field for stacking'),
    title: z.string().optional().default('Area Chart'),
    width: z.number().optional().default(600),
    height: z.number().optional().default(400),
  },
  async ({ data, x, y, color, title, width, height }) => {
    const spec: Record<string, unknown> = {
      width, height, title,
      data: { values: data },
      mark: { type: 'area', tooltip: true, opacity: 0.7 },
      encoding: {
        x: { field: x, type: 'temporal' },
        y: { field: y, type: 'quantitative', stack: 'zero' },
        ...(color ? { color: { field: color, type: 'nominal' } } : {}),
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
    data: dataSchema,
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
    data: dataSchema,
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
    data: dataSchema,
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
    data: dataSchema,
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
    data: dataSchema,
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
    data: dataSchema,
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
      projection: { type: 'mercator' },
      layer: [
        {
          data: { url: 'https://cdn.jsdelivr.net/npm/vega-datasets@v1.29.0/data/world-110m.json', format: { type: 'topojson', feature: 'countries' } },
          mark: { type: 'geoshape', fill: '#2a2a2a', stroke: '#444' },
        },
        {
          data: { values: data },
          mark: { type: 'circle', tooltip: true, opacity: 0.7 },
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
    spec: z.record(z.unknown()).describe('Full Vega-Lite specification object'),
    title: z.string().optional().default('Custom Chart'),
  },
  async ({ spec, title }) => {
    return vegaResult(spec, title!)
  },
)

console.error('[charts-mcp] Server started')
const transport = new StdioServerTransport()
server.connect(transport)

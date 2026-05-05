import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const serverEntry = resolve(packageRoot, 'dist/index.js')

const sampleRows = [
  {
    category: 'Alpha',
    value: 12,
    series: 'North',
    date: '2026-01-01',
    rank: 1,
    stage: 'Visit',
    source: 'Visit',
    target: 'Signup',
    latitude: 52.37,
    longitude: 4.9,
    open: 10,
    high: 14,
    low: 9,
    close: 13,
    actual: 72,
    targetValue: 80,
    rangeLow: 50,
    rangeMid: 70,
    rangeHigh: 90,
  },
  {
    category: 'Beta',
    value: 8,
    series: 'South',
    date: '2026-01-02',
    rank: 2,
    stage: 'Signup',
    source: 'Signup',
    target: 'Purchase',
    latitude: 40.71,
    longitude: -74.01,
    open: 13,
    high: 15,
    low: 11,
    close: 12,
    actual: 64,
    targetValue: 75,
    rangeLow: 45,
    rangeMid: 65,
    rangeHigh: 85,
  },
  {
    category: 'Gamma',
    value: 16,
    series: 'North',
    date: '2026-01-03',
    rank: 1,
    stage: 'Purchase',
    source: 'Visit',
    target: 'Purchase',
    latitude: 34.05,
    longitude: -118.24,
    open: 12,
    high: 18,
    low: 10,
    close: 17,
    actual: 91,
    targetValue: 90,
    rangeLow: 55,
    rangeMid: 75,
    rangeHigh: 95,
  },
]

const expectedToolCalls: Record<string, Record<string, unknown>> = {
  bar_chart: { data: sampleRows, x: 'category', y: 'value', title: 'Contract Bar' },
  line_chart: { data: sampleRows, x: 'date', y: 'value', color: 'series', title: 'Contract Line' },
  area_chart: { data: sampleRows, x: 'date', y: 'value', color: 'series', title: 'Contract Area' },
  scatter_plot: { data: sampleRows, x: 'actual', y: 'targetValue', color: 'series', size: 'value', title: 'Contract Scatter' },
  pie_chart: { data: sampleRows, category: 'category', value: 'value', title: 'Contract Pie' },
  histogram: { data: sampleRows, field: 'value', title: 'Contract Histogram' },
  heatmap: { data: sampleRows, x: 'category', y: 'series', value: 'value', title: 'Contract Heatmap' },
  boxplot: { data: sampleRows, category: 'series', value: 'value', title: 'Contract Boxplot' },
  map: { data: sampleRows, latitude: 'latitude', longitude: 'longitude', size: 'value', color: 'series', title: 'Contract Map' },
  funnel_chart: { data: sampleRows, stage: 'stage', value: 'value', title: 'Contract Funnel' },
  waterfall_chart: { data: sampleRows, category: 'category', value: 'value', title: 'Contract Waterfall' },
  bump_chart: { data: sampleRows, x: 'date', rank: 'rank', series: 'series', title: 'Contract Bump' },
  streamgraph: { data: sampleRows, x: 'date', y: 'value', series: 'series', title: 'Contract Streamgraph' },
  calendar_heatmap: { data: sampleRows, date: 'date', value: 'value', title: 'Contract Calendar' },
  bullet_chart: {
    data: sampleRows,
    category: 'category',
    actual: 'actual',
    target: 'targetValue',
    rangeLow: 'rangeLow',
    rangeMid: 'rangeMid',
    rangeHigh: 'rangeHigh',
    title: 'Contract Bullet',
  },
  candlestick_chart: {
    data: sampleRows,
    x: 'date',
    open: 'open',
    high: 'high',
    low: 'low',
    close: 'close',
    title: 'Contract Candlestick',
  },
  sankey: { data: sampleRows, source: 'source', target: 'target', value: 'value', title: 'Contract Sankey' },
  mermaid: { diagram: 'graph TD\n  A[Start] --> B[Done]', title: 'Contract Diagram' },
  custom_spec: {
    spec: {
      data: { values: sampleRows },
      mark: 'bar',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'value', type: 'quantitative' },
      },
    },
    title: 'Contract Custom',
  },
}

async function withChartsClient<T>(fn: (client: Client) => Promise<T>) {
  const client = new Client({ name: 'charts-contract-test', version: '1.0.0' }, { capabilities: {} })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    stderr: 'pipe',
  })

  await client.connect(transport)
  try {
    return await fn(client)
  } finally {
    await client.close().catch(() => {})
  }
}

function parseTextResult(result: Awaited<ReturnType<Client['callTool']>>) {
  assert.equal('isError' in result ? result.isError : false, false)
  assert.ok('content' in result, 'expected MCP tool result content')
  const [first] = result.content
  assert.equal(first?.type, 'text')
  assert.equal(typeof first.text, 'string')
  return JSON.parse(first.text) as Record<string, unknown>
}

test('charts MCP lists and executes every chart tool over stdio', async () => {
  await withChartsClient(async (client) => {
    const listed = await client.listTools()
    const toolNames = listed.tools.map((tool) => tool.name).sort()
    assert.deepEqual(toolNames, Object.keys(expectedToolCalls).sort())

    for (const [name, args] of Object.entries(expectedToolCalls)) {
      const parsed = parseTextResult(await client.callTool({ name, arguments: args }))
      assert.equal(parsed.title, args.title)
      assert.match(String(parsed.type), /^(vega|vega-lite|mermaid)$/)
    }
  })
})

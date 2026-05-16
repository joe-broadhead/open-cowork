import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { inferBarChartEncoding, inferSequentialXAxisEncoding, normalizeSeriesColorField } from './chart-utils.js'
import { chartToolDescription, vegaResult } from './chart-results.js'
import { chartBinCountSchema, chartDataSchema, chartDimensionSchema, chartFieldNameSchema } from './schemas.js'

export function registerBasicChartTools(server: McpServer) {
  server.tool(
    'bar_chart',
    chartToolDescription('Create an interactive bar chart. Great for comparing categories.'),
    {
      data: chartDataSchema,
      x: chartFieldNameSchema.describe('Field for x-axis. For vertical bars this is usually the category; for horizontal bars it is usually the numeric value.'),
      y: chartFieldNameSchema.describe('Field for y-axis. For vertical bars this is usually the numeric value; for horizontal bars it is usually the category.'),
      color: chartFieldNameSchema.optional().describe('Field for color grouping'),
      title: z.string().optional().default('Bar Chart'),
      horizontal: z.boolean().optional().default(false).describe('Horizontal bars'),
      width: chartDimensionSchema.optional().default(600),
      height: chartDimensionSchema.optional().default(400),
    },
    async ({ data, x, y, color, title, horizontal, width, height }) => {
      const spec: Record<string, unknown> = {
        width, height, title,
        data: { values: data },
        mark: { type: 'bar', tooltip: true },
        encoding: {
          ...inferBarChartEncoding(data, x, y, horizontal),
          ...(color ? { color: { field: color, type: 'nominal' } } : {}),
        },
      }
      return vegaResult(spec, title!)
    },
  )

  server.tool(
    'line_chart',
    chartToolDescription('Create an interactive line chart. Great for time series and trends.'),
    {
      data: chartDataSchema,
      x: chartFieldNameSchema.describe('Field for x-axis (usually time/date)'),
      y: chartFieldNameSchema.describe('Field for y-axis (values)'),
      color: chartFieldNameSchema.optional().describe('Field for multiple series'),
      title: z.string().optional().default('Line Chart'),
      width: chartDimensionSchema.optional().default(600),
      height: chartDimensionSchema.optional().default(400),
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

  server.tool(
    'area_chart',
    chartToolDescription('Create a stacked area chart. Great for showing composition over time.'),
    {
      data: chartDataSchema,
      x: chartFieldNameSchema.describe('Field for x-axis'),
      y: chartFieldNameSchema.describe('Field for y-axis'),
      color: chartFieldNameSchema.optional().describe('Field for stacking'),
      title: z.string().optional().default('Area Chart'),
      width: chartDimensionSchema.optional().default(600),
      height: chartDimensionSchema.optional().default(400),
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

  server.tool(
    'scatter_plot',
    chartToolDescription('Create an interactive scatter plot. Great for showing correlations.'),
    {
      data: chartDataSchema,
      x: chartFieldNameSchema.describe('Field for x-axis'),
      y: chartFieldNameSchema.describe('Field for y-axis'),
      color: chartFieldNameSchema.optional().describe('Field for color grouping'),
      size: chartFieldNameSchema.optional().describe('Field for bubble size'),
      title: z.string().optional().default('Scatter Plot'),
      width: chartDimensionSchema.optional().default(600),
      height: chartDimensionSchema.optional().default(400),
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

  server.tool(
    'pie_chart',
    chartToolDescription('Create a pie or donut chart. Great for showing proportions.'),
    {
      data: chartDataSchema,
      category: chartFieldNameSchema.describe('Field for categories/slices'),
      value: chartFieldNameSchema.describe('Field for values'),
      title: z.string().optional().default('Pie Chart'),
      donut: z.boolean().optional().default(false).describe('Make it a donut chart'),
      width: chartDimensionSchema.optional().default(400),
      height: chartDimensionSchema.optional().default(400),
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

  server.tool(
    'histogram',
    chartToolDescription('Create a histogram showing data distribution.'),
    {
      data: chartDataSchema,
      field: chartFieldNameSchema.describe('Field to bin'),
      bins: chartBinCountSchema.optional().default(20).describe('Number of bins'),
      title: z.string().optional().default('Histogram'),
      width: chartDimensionSchema.optional().default(600),
      height: chartDimensionSchema.optional().default(400),
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

  server.tool(
    'heatmap',
    chartToolDescription('Create a heatmap showing values across two dimensions.'),
    {
      data: chartDataSchema,
      x: chartFieldNameSchema.describe('Field for columns'),
      y: chartFieldNameSchema.describe('Field for rows'),
      value: chartFieldNameSchema.describe('Field for cell values (color intensity)'),
      title: z.string().optional().default('Heatmap'),
      width: chartDimensionSchema.optional().default(600),
      height: chartDimensionSchema.optional().default(400),
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

  server.tool(
    'boxplot',
    chartToolDescription('Create a box plot showing distribution statistics.'),
    {
      data: chartDataSchema,
      category: chartFieldNameSchema.describe('Field for categories'),
      value: chartFieldNameSchema.describe('Field for values'),
      title: z.string().optional().default('Box Plot'),
      width: chartDimensionSchema.optional().default(600),
      height: chartDimensionSchema.optional().default(400),
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

  server.tool(
    'map',
    chartToolDescription('Create a geographic map with data points. Data must include latitude and longitude fields.'),
    {
      data: chartDataSchema,
      latitude: chartFieldNameSchema.describe('Field for latitude'),
      longitude: chartFieldNameSchema.describe('Field for longitude'),
      size: chartFieldNameSchema.optional().describe('Field for point size'),
      color: chartFieldNameSchema.optional().describe('Field for point color'),
      title: z.string().optional().default('Map'),
      width: chartDimensionSchema.optional().default(700),
      height: chartDimensionSchema.optional().default(500),
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
}

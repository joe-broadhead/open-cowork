import test from 'node:test'
import assert from 'node:assert/strict'
import { applyVegaTheme, isFullVegaSpec, makeInteractiveVegaSpecResponsive, normalizeVegaSpecSchema } from '../apps/desktop/src/renderer/components/chat/vega-chart-utils.ts'

test('normalizeVegaSpecSchema upgrades legacy vega-lite schemas to v6', () => {
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    mark: 'bar',
  }

  assert.deepEqual(normalizeVegaSpecSchema(spec), {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    mark: 'bar',
  })
})

test('normalizeVegaSpecSchema leaves full vega specs untouched', () => {
  const spec = {
    $schema: 'https://vega.github.io/schema/vega/v5.json',
    marks: [],
  }

  assert.equal(normalizeVegaSpecSchema(spec), spec)
  assert.equal(isFullVegaSpec(spec), true)
})

test('applyVegaTheme preserves explicit chart dimensions for static rendering', () => {
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    width: 600,
    height: 400,
    mark: 'bar',
  }

  const themed = applyVegaTheme(spec, {
    axis: '#ccc',
    title: '#fff',
    grid: '#333',
    domain: '#444',
    accent: '#9cf',
    green: '#0f0',
    amber: '#fa0',
    red: '#f44',
    info: '#4af',
    muted: '#999',
    secondary: '#bbb',
  })

  assert.equal(themed.width, 600)
  assert.equal(themed.height, 400)
  assert.equal('autosize' in themed, false)
})

test('makeInteractiveVegaSpecResponsive makes simple Vega-Lite specs fit the container width', () => {
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    width: 700,
    height: 400,
    mark: 'bar',
    encoding: {},
  }

  const responsive = makeInteractiveVegaSpecResponsive(spec)

  assert.equal(responsive.width, 'container')
  assert.deepEqual(responsive.autosize, {
    type: 'fit-x',
    contains: 'padding',
    resize: true,
  })
  assert.equal(responsive.height, 400)
})

test('makeInteractiveVegaSpecResponsive leaves composed Vega-Lite specs unchanged', () => {
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    hconcat: [{ mark: 'bar' }, { mark: 'line' }],
  }

  const responsive = makeInteractiveVegaSpecResponsive(spec)

  assert.deepEqual(responsive, spec)
})

test('makeInteractiveVegaSpecResponsive gives dense horizontal bar charts more vertical room and label budget', () => {
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    width: 700,
    height: 400,
    mark: 'bar',
    data: {
      values: Array.from({ length: 10 }, (_, index) => ({
        universe_name: `Universe ${index + 1}`,
        total: index + 1,
      })),
    },
    encoding: {
      x: { field: 'total', type: 'quantitative' },
      y: { field: 'universe_name', type: 'nominal' },
    },
  }

  const responsive = makeInteractiveVegaSpecResponsive(spec)
  const yAxis = (responsive.encoding as Record<string, any>).y.axis

  assert.equal(responsive.height, 520)
  assert.equal(yAxis.labelLimit, 320)
  assert.equal(yAxis.labelPadding, 10)
})

test('makeInteractiveVegaSpecResponsive keeps arc legends readable in chat layouts', () => {
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    mark: { type: 'arc', tooltip: true },
    encoding: {
      theta: { field: 'value', type: 'quantitative' },
      color: { field: 'category', type: 'nominal' },
    },
  }

  const responsive = makeInteractiveVegaSpecResponsive(spec)
  const legend = ((responsive.encoding as Record<string, any>).color.legend)

  assert.equal(legend.orient, 'right')
  assert.equal(legend.labelLimit, 280)
  assert.equal(legend.symbolType, 'circle')
  assert.equal(responsive.height, 420)
})

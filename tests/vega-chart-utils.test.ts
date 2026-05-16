import test from 'node:test'
import assert from 'node:assert/strict'
import { isFullVegaSpec, normalizeVegaSpecSchema } from '../apps/desktop/src/lib/vega-spec.ts'
import { applyVegaTheme, makeInteractiveVegaSpecResponsive } from '../apps/desktop/src/renderer/components/chat/vega-chart-utils.ts'

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

test('normalizeVegaSpecSchema treats human daily labels as ordered categories', () => {
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    data: {
      values: [
        { session_date: 'Sun 3 May', sessions: 145898 },
        { session_date: 'Mon 4 May', sessions: 155270 },
        { session_date: 'Tue 5 May', sessions: 126579 },
        { session_date: 'Wed 6 May', sessions: 120673 },
        { session_date: 'Thu 7 May', sessions: 133894 },
      ],
    },
    mark: { type: 'line', point: true },
    encoding: {
      x: { field: 'session_date', type: 'temporal' },
      y: { field: 'sessions', type: 'quantitative' },
    },
  }

  const normalized = normalizeVegaSpecSchema(spec)
  const x = (normalized.encoding as Record<string, any>).x

  assert.equal(x.type, 'ordinal')
  assert.deepEqual(x.sort, ['Sun 3 May', 'Mon 4 May', 'Tue 5 May', 'Wed 6 May', 'Thu 7 May'])
})

test('normalizeVegaSpecSchema treats long human date labels as ordered categories', () => {
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    data: {
      values: [
        { date: 'Apr 26, 2026', sessions: 164821 },
        { date: 'Apr 27, 2026', sessions: 151204 },
        { date: 'Apr 28, 2026', sessions: 139842 },
        { date: 'Apr 29, 2026', sessions: 134998 },
        { date: 'Apr 30, 2026', sessions: 127392 },
      ],
    },
    mark: { type: 'line', point: true },
    encoding: {
      x: { field: 'date', type: 'temporal' },
      y: { field: 'sessions', type: 'quantitative' },
    },
  }

  const normalized = normalizeVegaSpecSchema(spec)
  const x = (normalized.encoding as Record<string, any>).x

  assert.equal(x.type, 'ordinal')
  assert.deepEqual(x.sort, ['Apr 26, 2026', 'Apr 27, 2026', 'Apr 28, 2026', 'Apr 29, 2026', 'Apr 30, 2026'])
})

test('normalizeVegaSpecSchema treats full month date labels as ordered categories', () => {
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    data: {
      values: [
        { date: 'April 26, 2026', sessions: 164821 },
        { date: 'April 27, 2026', sessions: 151204 },
      ],
    },
    mark: 'line',
    encoding: {
      x: { field: 'date', type: 'temporal' },
      y: { field: 'sessions', type: 'quantitative' },
    },
  }

  const normalized = normalizeVegaSpecSchema(spec)
  const x = (normalized.encoding as Record<string, any>).x

  assert.equal(x.type, 'ordinal')
  assert.deepEqual(x.sort, ['April 26, 2026', 'April 27, 2026'])
})

test('normalizeVegaSpecSchema preserves real temporal date fields', () => {
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    data: {
      values: [
        { session_date: '2026-05-03', sessions: 145898 },
        { session_date: '2026-05-04', sessions: 155270 },
      ],
    },
    mark: { type: 'line', point: true },
    encoding: {
      x: { field: 'session_date', type: 'temporal' },
      y: { field: 'sessions', type: 'quantitative' },
    },
  }

  const normalized = normalizeVegaSpecSchema(spec)
  const x = (normalized.encoding as Record<string, any>).x

  assert.equal(x.type, 'temporal')
  assert.equal('sort' in x, false)
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

test('makeInteractiveVegaSpecResponsive scales full Vega specs to the container width', () => {
  const spec = {
    $schema: 'https://vega.github.io/schema/vega/v5.json',
    width: 720,
    height: 420,
    marks: [{ type: 'rect' }, { type: 'text' }],
  }

  const responsive = makeInteractiveVegaSpecResponsive(spec)

  assert.equal(responsive.width, 'container')
  assert.deepEqual(responsive.autosize, {
    type: 'fit-x',
    contains: 'padding',
    resize: true,
  })
  // Node positions are baked into full Vega specs, so height stays fixed.
  assert.equal(responsive.height, 420)
  assert.deepEqual(responsive.marks, spec.marks)
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

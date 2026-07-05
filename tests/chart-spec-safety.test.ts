import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_CHART_ARRAY_ITEMS,
  MAX_CHART_DEPTH,
  MAX_CHART_SPEC_BYTES,
  validateInlineChartSpec,
} from '../packages/shared/src/chart-spec-safety.ts'
import {
  MAX_CHART_ESTIMATED_ROWS,
  MAX_CHART_GENERATED_ROWS,
  assertBoundedVegaSpecCardinality,
} from '../apps/desktop/src/main/chart-spec-safety.ts'
import { renderChartSpecToSvg } from '../apps/desktop/src/main/chart-renderer.ts'

test('validateInlineChartSpec accepts bounded inline data specs', () => {
  assert.doesNotThrow(() => validateInlineChartSpec({
    data: { values: [{ category: 'A', value: 1 }] },
    mark: 'bar',
    encoding: {
      x: { field: 'category', type: 'nominal' },
      y: { field: 'value', type: 'quantitative' },
    },
  }))
})

test('validateInlineChartSpec rejects external resource references and image marks', () => {
  assert.throws(
    () => validateInlineChartSpec({ data: { url: 'https://example.test/data.csv' }, mark: 'bar' }),
    /url=.*not allowed/,
  )
  assert.throws(
    () => validateInlineChartSpec({ data: { url: 'data:text/csv;base64,YSxiCjEsMg==' }, mark: 'bar' }),
    /url=.*not allowed/,
  )
  assert.throws(
    () => validateInlineChartSpec({ mark: 'text', href: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' }),
    /href=.*not allowed/,
  )
  assert.throws(
    () => validateInlineChartSpec({ mark: 'text', src: 'data:image/svg+xml;base64,PHN2Zy8+' }),
    /src=.*not allowed/,
  )
  assert.throws(
    () => validateInlineChartSpec({ data: { values: [] }, mark: 'image' }),
    /image marks are not allowed/,
  )
  assert.throws(
    () => validateInlineChartSpec({ data: { values: [] }, mark: { type: 'image' } }),
    /image marks are not allowed/,
  )
})

test('validateInlineChartSpec rejects oversized chart specs', () => {
  assert.throws(
    () => validateInlineChartSpec({ data: { values: [{ text: 'x'.repeat(MAX_CHART_SPEC_BYTES) }] }, mark: 'text' }),
    /spec exceeds/,
  )
  assert.throws(
    () => validateInlineChartSpec({ data: { values: Array.from({ length: MAX_CHART_ARRAY_ITEMS + 1 }, () => null) }, mark: 'point' }),
    /total array items/,
  )

  let nested: Record<string, unknown> = { value: 1 }
  for (let index = 0; index < MAX_CHART_DEPTH + 1; index += 1) {
    nested = { nested }
  }
  assert.throws(() => validateInlineChartSpec(nested), /maximum depth/)
})

test('assertBoundedVegaSpecCardinality accepts normal inline-data pipelines', () => {
  assert.doesNotThrow(() => assertBoundedVegaSpecCardinality({
    data: [
      { name: 'source_0', values: [{ a: 1 }, { a: 2 }] },
      {
        name: 'data_0',
        source: 'source_0',
        transform: [
          { type: 'fold', fields: ['a'], as: ['key', 'value'] },
          { type: 'filter', expr: 'isValid(datum["a"])' },
        ],
      },
    ],
    marks: [{ type: 'rect', from: { data: 'data_0' } }],
  }))
})

test('assertBoundedVegaSpecCardinality bounds sequence generators', () => {
  const sequenceSpec = (stop: unknown, step?: unknown) => ({
    data: [{ name: 'source_0', transform: [{ type: 'sequence', start: 0, stop, ...(step === undefined ? {} : { step }) }] }],
  })

  assert.doesNotThrow(() => assertBoundedVegaSpecCardinality(sequenceSpec(MAX_CHART_GENERATED_ROWS)))
  assert.throws(() => assertBoundedVegaSpecCardinality(sequenceSpec(1e9)), /sequence transform would generate/)
  assert.throws(() => assertBoundedVegaSpecCardinality(sequenceSpec(MAX_CHART_GENERATED_ROWS + 1)), /sequence transform would generate/)
  // Signal-driven bounds cannot be statically bounded and must be rejected.
  assert.throws(() => assertBoundedVegaSpecCardinality(sequenceSpec({ signal: 'width' })), /finite numeric/)
  assert.throws(() => assertBoundedVegaSpecCardinality(sequenceSpec(10, 0)), /finite numeric/)
})

test('assertBoundedVegaSpecCardinality rejects unboundable amplifying transforms', () => {
  assert.throws(
    () => assertBoundedVegaSpecCardinality({
      data: [
        { name: 'a', values: Array.from({ length: 100 }, (_, index) => ({ index })) },
        { name: 'b', source: 'a', transform: [{ type: 'cross' }] },
      ],
    }),
    /cross transforms are not allowed/,
  )
  assert.throws(
    () => assertBoundedVegaSpecCardinality({
      data: [{ name: 'grid', transform: [{ type: 'graticule', stepMinor: [0.0001, 0.0001] }] }],
    }),
    /graticule transforms are not allowed/,
  )
  assert.throws(
    () => assertBoundedVegaSpecCardinality({
      data: [{ name: 'folded', values: [{ a: 1 }], transform: [{ type: 'fold', fields: { signal: 'fields' } }] }],
    }),
    /fold transforms require a static fields array/,
  )
})

test('assertBoundedVegaSpecCardinality caps estimated derived rows across chained pipelines', () => {
  const fields = ['a', 'b', 'c', 'd']
  const rows = Array.from({ length: MAX_CHART_ARRAY_ITEMS - 10 }, (_, index) => ({ a: index }))
  assert.throws(
    () => assertBoundedVegaSpecCardinality({
      data: [
        { name: 'source_0', values: rows },
        { name: 'data_0', source: 'source_0', transform: [{ type: 'fold', fields }, { type: 'fold', fields }] },
      ],
    }),
    new RegExp(`max ${MAX_CHART_ESTIMATED_ROWS}`),
  )
  // Fold duplication feeding a flatten in a downstream pipeline is also bounded.
  assert.throws(
    () => assertBoundedVegaSpecCardinality({
      data: [
        { name: 'source_0', values: [{ a: [1, 2] }], transform: [{ type: 'fold', fields }] },
        { name: 'data_0', source: 'source_0', transform: [{ type: 'flatten', fields: ['a'] }] },
      ],
    }),
    new RegExp(`max ${MAX_CHART_ESTIMATED_ROWS}`),
  )
  // A plain flatten over inline data stays within the cap.
  assert.doesNotThrow(() => assertBoundedVegaSpecCardinality({
    data: [
      { name: 'source_0', values: [{ a: [1, 2, 3] }] },
      { name: 'data_0', source: 'source_0', transform: [{ type: 'flatten', fields: ['a'] }] },
    ],
  }))
})

test('assertBoundedVegaSpecCardinality bounds density and quantile step parameters', () => {
  assert.throws(
    () => assertBoundedVegaSpecCardinality({
      data: [{ name: 'd', values: [{ v: 1 }], transform: [{ type: 'kde', field: 'v', steps: 1e8 }] }],
    }),
    /must be a finite number/,
  )
  assert.throws(
    () => assertBoundedVegaSpecCardinality({
      data: [{ name: 'd', values: [{ v: 1 }], transform: [{ type: 'quantile', field: 'v', step: 1e-9 }] }],
    }),
    /quantile transform step/,
  )
  assert.doesNotThrow(() => assertBoundedVegaSpecCardinality({
    data: [{ name: 'd', values: [{ v: 1 }, { v: 2 }], transform: [{ type: 'kde', field: 'v' }] }],
  }))
})

test('assertBoundedVegaSpecCardinality inspects datasets nested inside group marks', () => {
  assert.throws(
    () => assertBoundedVegaSpecCardinality({
      data: [{ name: 'source_0', values: [] }],
      marks: [{
        type: 'group',
        data: [{ name: 'inner', transform: [{ type: 'sequence', start: 0, stop: 1e9 }] }],
      }],
    }),
    /sequence transform would generate/,
  )
})

test('renderChartSpecToSvg rejects generative sequence specs before evaluating them', async () => {
  // Regression for audit issue #865: this ~193 byte spec passed the shared
  // input-size validation but synchronously materialized 1e9 rows inside
  // vega.parse/toSVG, blocking the event loop before the render timeout could
  // fire. The cardinality guard must reject it before vega.parse runs.
  await assert.rejects(
    renderChartSpecToSvg({
      $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
      data: { sequence: { start: 0, stop: 1e9 } },
      mark: 'line',
      encoding: { x: { field: 'data', type: 'quantitative' } },
    }),
    /unsafe or oversized spec/i,
  )
})

test('renderChartSpecToSvg still renders bounded sequence specs', async () => {
  const svg = await renderChartSpecToSvg({
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    data: { sequence: { start: 0, stop: 50, as: 'x' } },
    transform: [{ calculate: 'sin(datum.x / 5)', as: 'y' }],
    mark: 'line',
    encoding: {
      x: { field: 'x', type: 'quantitative' },
      y: { field: 'y', type: 'quantitative' },
    },
  })
  assert.match(svg, /<svg[\s>]/)
})

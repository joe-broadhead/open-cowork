import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_CHART_ARRAY_ITEMS,
  MAX_CHART_DEPTH,
  MAX_CHART_SPEC_BYTES,
  validateInlineChartSpec,
} from '../packages/shared/src/chart-spec-safety.ts'

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

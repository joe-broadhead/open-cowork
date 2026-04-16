import assert from 'node:assert/strict'
import test from 'node:test'
import { renderChartSpecToSvg, resolveChartRenderTimeoutMs } from '../apps/desktop/src/main/chart-renderer.ts'

test('resolveChartRenderTimeoutMs clamps to safe bounds', () => {
  assert.equal(resolveChartRenderTimeoutMs(undefined), 1500)
  assert.equal(resolveChartRenderTimeoutMs('100'), 250)
  assert.equal(resolveChartRenderTimeoutMs('1750'), 1750)
  assert.equal(resolveChartRenderTimeoutMs('999999'), 10_000)
  assert.equal(resolveChartRenderTimeoutMs('not-a-number'), 1500)
})

test('renderChartSpecToSvg renders Vega-Lite specs as SVG', async () => {
  const svg = await renderChartSpecToSvg({
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    data: {
      values: [
        { category: 'A', value: 3 },
        { category: 'B', value: 5 },
      ],
    },
    mark: 'bar',
    encoding: {
      x: { field: 'category', type: 'nominal' },
      y: { field: 'value', type: 'quantitative' },
    },
  })

  assert.match(svg, /<svg[\s>]/)
  assert.match(svg, /A/)
  assert.match(svg, /B/)
})

test('renderChartSpecToSvg rejects external resource URLs', async () => {
  await assert.rejects(
    renderChartSpecToSvg({
      $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
      data: {
        url: 'https://example.com/data.csv',
      },
      mark: 'bar',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'value', type: 'quantitative' },
      },
    }),
    /only supports local inline specs/i,
  )
})

test('renderChartSpecToSvg rejects oversized specs', async () => {
  await assert.rejects(
    renderChartSpecToSvg({
      $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
      data: {
        values: Array.from({ length: 25_000 }, (_, index) => ({ category: `A${index}`, value: index })),
      },
      mark: 'bar',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'value', type: 'quantitative' },
      },
    }),
    /unsafe or oversized spec/i,
  )
})

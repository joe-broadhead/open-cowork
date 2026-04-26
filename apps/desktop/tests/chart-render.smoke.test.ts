import assert from 'node:assert/strict'
import test from 'node:test'
import { launchSmokeApp } from './smoke-helpers.ts'

test('chart renderer round-trips through preload and main IPC', async () => {
  const { page, cleanup } = await launchSmokeApp()
  try {
    // `chart.renderSvg` is exposed on the preload surface so we invoke it
    // via window.coworkApi to prove the full IPC path. An inline-data spec
    // should render; an external-URL data spec should be rejected by the
    // server-side validator.
    await page.waitForFunction(() => typeof window.coworkApi?.chart?.renderSvg === 'function')

    const svg = await page.evaluate(async () => {
      return window.coworkApi.chart.renderSvg({
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
    })

    assert.match(svg, /<svg[\s>]/)
    assert.match(svg, /A/)
    assert.match(svg, /B/)

    const blocked = await page.evaluate(async () => {
      try {
        await window.coworkApi.chart.renderSvg({
          $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
          data: { url: 'https://example.com/remote.csv' },
          mark: 'bar',
          encoding: {
            x: { field: 'category', type: 'nominal' },
            y: { field: 'value', type: 'quantitative' },
          },
        })
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })

    assert.match(blocked || '', /only supports local inline specs/i)
  } finally {
    await cleanup()
  }
})

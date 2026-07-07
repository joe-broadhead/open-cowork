import assert from 'node:assert/strict'
import test from 'node:test'
import { launchSmokeApp } from './smoke-helpers.ts'
import { captureEvidence } from './eval-helpers.ts'

// EVAL FLOW: an artifact/chart renders through the real preload → main IPC
// path and paints into the sandboxed chart frame.
//
// Drives `window.coworkApi.chart.renderSvg` (the same IPC the chart artifact
// uses) with an inline-data spec, mounts the result in the page, and captures
// visual evidence. Also confirms the security boundary: an external-URL spec
// is rejected. Fully offline — Vega renders locally.
test('eval:artifact-chart — inline chart renders and external-data is rejected', async () => {
  const { page, cleanup } = await launchSmokeApp()
  try {
    await page.waitForFunction(() => typeof window.coworkApi?.chart?.renderSvg === 'function')

    const svg = await page.evaluate(async () => {
      return window.coworkApi.chart.renderSvg({
        $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
        data: {
          values: [
            { quarter: 'Q1', revenue: 12 },
            { quarter: 'Q2', revenue: 19 },
            { quarter: 'Q3', revenue: 7 },
            { quarter: 'Q4', revenue: 25 },
          ],
        },
        mark: 'bar',
        encoding: {
          x: { field: 'quarter', type: 'nominal' },
          y: { field: 'revenue', type: 'quantitative' },
        },
      })
    })

    assert.match(svg, /<svg[\s>]/)
    assert.match(svg, /Q1/)
    assert.match(svg, /Q4/)

    // Mount the SVG so the evidence screenshot shows a painted chart.
    await page.evaluate((markup) => {
      const host = document.createElement('div')
      host.setAttribute('data-testid', 'eval-chart-host')
      host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#0b0b0f;display:flex;align-items:center;justify-content:center;padding:48px'
      host.innerHTML = markup
      document.body.appendChild(host)
    }, svg)
    await page.locator('[data-testid="eval-chart-host"] svg').waitFor({ timeout: 10_000 })
    await captureEvidence(page, 'artifact-chart', '01-inline-chart')

    // Security boundary: external-URL data specs must be refused.
    const blocked = await page.evaluate(async () => {
      try {
        await window.coworkApi.chart.renderSvg({
          $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
          data: { url: 'https://example.com/remote.csv' },
          mark: 'bar',
          encoding: {
            x: { field: 'quarter', type: 'nominal' },
            y: { field: 'revenue', type: 'quantitative' },
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

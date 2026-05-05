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

    const frameResult = await page.evaluate(async () => {
      const iframe = document.createElement('iframe')
      iframe.sandbox.add('allow-scripts')
      iframe.src = new URL('./chart-frame.html', window.location.href).toString()
      document.body.appendChild(iframe)

      return await new Promise<{ ok: true; height: number } | { ok: false; message: string }>((resolveFrame) => {
        let settled = false
        let requestSent = false
        const finish = (result: { ok: true; height: number } | { ok: false; message: string }) => {
          if (settled) return
          settled = true
          window.clearInterval(pingInterval)
          window.clearTimeout(timeout)
          window.removeEventListener('message', onMessage)
          iframe.remove()
          resolveFrame(result)
        }
        const renderSpec = {
          $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
          data: { values: [{ category: 'A', value: 1 }] },
          mark: 'bar',
          encoding: {
            x: { field: 'category', type: 'nominal' },
            y: { field: 'value', type: 'quantitative' },
          },
        }
        const onMessage = (event: MessageEvent) => {
          if (event.source !== iframe.contentWindow) return
          const data = event.data
          if (!data || typeof data !== 'object') return
          if (data.type === 'chart-frame-ready' && !requestSent) {
            requestSent = true
            iframe.contentWindow?.postMessage({ type: 'render-chart', requestId: 1, spec: renderSpec }, '*')
            return
          }
          if (data.type === 'chart-ready' && data.requestId === 1) {
            finish({ ok: true, height: Number(data.height) || 0 })
            return
          }
          if (data.type === 'chart-error') {
            finish({ ok: false, message: String(data.message || 'chart frame error') })
          }
        }
        window.addEventListener('message', onMessage)
        const pingInterval = window.setInterval(() => {
          iframe.contentWindow?.postMessage({ type: 'chart-frame-ping' }, '*')
        }, 100)
        const timeout = window.setTimeout(() => {
          finish({ ok: false, message: 'chart frame did not initialize' })
        }, 5_000)
      })
    })

    assert.equal(frameResult.ok, true, frameResult.ok ? undefined : frameResult.message)
    if (frameResult.ok) {
      assert.ok(frameResult.height > 0)
    }
  } finally {
    await cleanup()
  }
})

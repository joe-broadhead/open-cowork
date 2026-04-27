import embed, { type Result as VegaEmbedResult } from 'vega-embed'
import { validateInlineChartSpec } from '../lib/chart-spec-safety'

type ChartRenderMessage = {
  type: 'render-chart'
  requestId: number
  spec: Record<string, unknown>
}

type ChartCaptureMessage = {
  type: 'capture-chart'
  requestId: number
  scale?: number
}

type ChartResponseMessage =
  | { type: 'chart-frame-ready' }
  | { type: 'chart-ready'; requestId: number; height: number }
  | { type: 'chart-error'; requestId: number; message: string }
  | { type: 'chart-capture'; requestId: number; dataUrl: string }
  | { type: 'chart-capture-error'; requestId: number; message: string }

const root = document.getElementById('chart-root')
let activeChartResizeObserver: ResizeObserver | null = null
// Keep the live vega view around so a later capture request can call
// `view.toImageURL('png')` without needing to re-render. Replaced on
// each successful render; cleared on teardown.
let activeView: VegaEmbedResult['view'] | null = null

function denyChartResourceAccess(uri?: string) {
  const detail = uri ? `external resource "${uri}" is not allowed` : 'external resources are not allowed'
  return Promise.reject(new Error(`Chart rendering only supports local inline specs: ${detail}`))
}

function createRestrictedVegaLoader() {
  return {
    options: {},
    fileAccess: false,
    sanitize: (uri?: string) => denyChartResourceAccess(uri),
    load: (uri?: string) => denyChartResourceAccess(uri),
    file: (uri?: string) => denyChartResourceAccess(uri),
    http: (uri?: string) => denyChartResourceAccess(uri),
  }
}

function postToParent(message: ChartResponseMessage) {
  // Use `document.referrer` when available (packaged app: `file://`; dev:
  // `http://localhost:5173`) so the parent origin is explicit rather than
  // "any listener, anywhere". Falls back to the frame's own origin which
  // in Electron same-origin iframes matches the parent. `"*"` is never
  // used — it would let an injected cross-origin listener read the chart
  // response payload.
  const parentOrigin = document.referrer
    ? new URL(document.referrer).origin
    : window.location.origin
  window.parent.postMessage(message, parentOrigin)
}

function expectedParentOrigin() {
  try {
    return document.referrer
      ? new URL(document.referrer).origin
      : window.location.origin
  } catch {
    return window.location.origin
  }
}

function isOpaqueFileOrigin(origin: string) {
  return origin === 'null' || origin === 'file://'
}

function parentOriginMatches(eventOrigin: string) {
  const expectedOrigin = expectedParentOrigin()
  return eventOrigin === expectedOrigin
    || (isOpaqueFileOrigin(eventOrigin) && isOpaqueFileOrigin(expectedOrigin))
}

function shouldHandleParentMessage(event: MessageEvent) {
  return event.source === window.parent && parentOriginMatches(event.origin)
}

function measureChartHeight() {
  if (!root) return 0
  const svg = root.querySelector('svg')
  const renderedSvgHeight = svg instanceof SVGSVGElement
    ? Math.ceil(svg.getBoundingClientRect().height || svg.height.baseVal.value || 0)
    : 0
  const rootHeight = Math.ceil(root.getBoundingClientRect().height || 0)
  const documentHeight = Math.ceil(document.documentElement.scrollHeight || 0)
  const bodyHeight = Math.ceil(document.body.scrollHeight || 0)
  return Math.max(renderedSvgHeight, rootHeight, documentHeight, bodyHeight, 180)
}

async function renderChart(message: ChartRenderMessage) {
  if (!root) {
    postToParent({ type: 'chart-error', requestId: message.requestId, message: 'Chart frame root not found' })
    return
  }

  root.innerHTML = ''
  activeChartResizeObserver?.disconnect()
  activeChartResizeObserver = null
  activeView = null

  try {
    validateInlineChartSpec(message.spec)
    const result = await embed(root, message.spec as any, {
      actions: false,
      renderer: 'svg',
      loader: createRestrictedVegaLoader() as any,
    })
    activeView = result.view

    const reportHeight = () => {
      const chartHeight = Math.max(measureChartHeight(), result.view.height() + 40)
      postToParent({ type: 'chart-ready', requestId: message.requestId, height: chartHeight })
    }

    result.view.resize()
    await result.view.runAsync()

    reportHeight()

    requestAnimationFrame(() => {
      reportHeight()
      requestAnimationFrame(reportHeight)
    })

    activeChartResizeObserver = new ResizeObserver(() => {
      reportHeight()
    })
    activeChartResizeObserver.observe(root)
  } catch (error: unknown) {
    postToParent({
      type: 'chart-error',
      requestId: message.requestId,
      message: error instanceof Error ? error.message : 'Failed to render chart',
    })
  }
}

async function captureChart(message: ChartCaptureMessage) {
  if (!activeView) {
    postToParent({
      type: 'chart-capture-error',
      requestId: message.requestId,
      message: 'No active chart view to capture',
    })
    return
  }

  try {
    // Vega's `toImageURL` renders through an offscreen canvas regardless
    // of the visible renderer (we use SVG for display). Scale 2 keeps
    // it crisp on retina without bloating the PNG too much.
    const scale = typeof message.scale === 'number' && message.scale > 0 ? message.scale : 2
    const dataUrl = await activeView.toImageURL('png', scale)
    postToParent({ type: 'chart-capture', requestId: message.requestId, dataUrl })
  } catch (error: unknown) {
    postToParent({
      type: 'chart-capture-error',
      requestId: message.requestId,
      message: error instanceof Error ? error.message : 'Failed to capture chart PNG',
    })
  }
}

window.addEventListener('message', (event) => {
  if (!shouldHandleParentMessage(event)) return
  const data = event.data as ChartRenderMessage | ChartCaptureMessage | undefined
  if (!data || typeof data.requestId !== 'number') return
  if (data.type === 'render-chart' && (data as ChartRenderMessage).spec) {
    void renderChart(data as ChartRenderMessage)
    return
  }
  if (data.type === 'capture-chart') {
    void captureChart(data as ChartCaptureMessage)
  }
})

window.addEventListener('error', (event) => {
  postToParent({
    type: 'chart-error',
    requestId: -1,
    message: event.error?.message || event.message || 'Chart frame failed to load',
  })
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason as { message?: string } | string | undefined
  postToParent({
    type: 'chart-error',
    requestId: -1,
    message: typeof reason === 'string' ? reason : reason?.message || 'Chart frame failed to initialize',
  })
})

window.addEventListener('beforeunload', () => {
  activeChartResizeObserver?.disconnect()
  activeChartResizeObserver = null
  activeView = null
})

postToParent({ type: 'chart-frame-ready' })

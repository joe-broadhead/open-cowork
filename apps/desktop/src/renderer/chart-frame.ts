import embed from 'vega-embed'

type ChartRenderMessage = {
  type: 'render-chart'
  requestId: number
  spec: Record<string, unknown>
}

type ChartResponseMessage =
  | { type: 'chart-frame-ready' }
  | { type: 'chart-ready'; requestId: number; height: number }
  | { type: 'chart-error'; requestId: number; message: string }

const root = document.getElementById('chart-root')
let activeChartResizeObserver: ResizeObserver | null = null

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
  window.parent.postMessage(message, '*')
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

  try {
    const result = await embed(root, message.spec as any, {
      actions: false,
      renderer: 'svg',
      loader: createRestrictedVegaLoader() as any,
    })

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
  } catch (error: any) {
    postToParent({
      type: 'chart-error',
      requestId: message.requestId,
      message: error?.message || 'Failed to render chart',
    })
  }
}

window.addEventListener('message', (event) => {
  const data = event.data as ChartRenderMessage | undefined
  if (!data || data.type !== 'render-chart' || typeof data.requestId !== 'number' || !data.spec) return
  void renderChart(data)
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
})

postToParent({ type: 'chart-frame-ready' })

import { isFullVegaSpec, normalizeVegaSpecSchema } from '../lib/vega-spec.ts'
import { validateInlineChartSpec } from '../lib/chart-spec-safety.ts'

const DEFAULT_CHART_RENDER_TIMEOUT_MS = 1_500
const MIN_CHART_RENDER_TIMEOUT_MS = 250
const MAX_CHART_RENDER_TIMEOUT_MS = 10_000
const BLOCKED_SVG_ELEMENT_PATTERN = /<(?:image|foreignObject)\b/i
const BLOCKED_SVG_EXTERNAL_RESOURCE_PATTERN = /\b(?:href|xlink:href)\s*=\s*['"]\s*(?:https?:|file:|data:|javascript:)/i

type VegaModule = typeof import('vega')
type VegaLiteModule = typeof import('vega-lite')

let cachedChartRenderModules: Promise<{ vega: VegaModule; vegaLite: VegaLiteModule }> | null = null

function createBlockedChartResourceError(detail: string) {
  return new Error(`Chart rendering only supports local inline specs: ${detail}`)
}

function createBlockedChartRenderError(detail: string) {
  return new Error(`Chart rendering rejected an unsafe or oversized spec: ${detail}`)
}

export function resolveChartRenderTimeoutMs(rawValue = process.env.OPEN_COWORK_CHART_TIMEOUT_MS) {
  const raw = Number(rawValue)
  if (!Number.isFinite(raw)) return DEFAULT_CHART_RENDER_TIMEOUT_MS
  const rounded = Math.round(raw)
  return Math.min(MAX_CHART_RENDER_TIMEOUT_MS, Math.max(MIN_CHART_RENDER_TIMEOUT_MS, rounded))
}

async function getChartRenderModules() {
  if (!cachedChartRenderModules) {
    cachedChartRenderModules = Promise.all([
      import('vega'),
      import('vega-lite'),
    ]).then(([vega, vegaLite]) => ({ vega, vegaLite }))
  }
  return cachedChartRenderModules
}

function denyChartResourceAccess(uri?: string) {
  const detail = uri ? `external resource "${uri}" is not allowed` : 'external resources are not allowed'
  return Promise.reject(createBlockedChartResourceError(detail))
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

function toRenderableVegaSpec(spec: Record<string, unknown>, compile: VegaLiteModule['compile']) {
  const normalizedSpec = normalizeVegaSpecSchema(spec)
  if (isFullVegaSpec(normalizedSpec)) {
    return normalizedSpec
  }
  return compile(normalizedSpec as any).spec as Record<string, unknown>
}

export async function renderChartSpecToSvg(spec: Record<string, unknown>) {
  const chartRenderTimeoutMs = resolveChartRenderTimeoutMs()
  validateInlineChartSpec(spec)
  const { vega, vegaLite } = await getChartRenderModules()
  const vegaSpec = toRenderableVegaSpec(spec, vegaLite.compile)
  const runtime = vega.parse(vegaSpec as any)
  const view = new vega.View(runtime, {
    loader: createRestrictedVegaLoader() as any,
    renderer: 'none',
  })

  let timeout: NodeJS.Timeout | null = null

  try {
    const svg = await Promise.race([
      view.toSVG(),
      new Promise<string>((_, reject) => {
        timeout = setTimeout(() => {
          reject(createBlockedChartRenderError(`render exceeded ${chartRenderTimeoutMs}ms; simplify the chart or raise OPEN_COWORK_CHART_TIMEOUT_MS`))
        }, chartRenderTimeoutMs)
      }),
    ])

    if (BLOCKED_SVG_ELEMENT_PATTERN.test(svg) || BLOCKED_SVG_EXTERNAL_RESOURCE_PATTERN.test(svg)) {
      throw createBlockedChartResourceError('rendered SVG contains blocked external resources')
    }

    return svg
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
    view.finalize()
  }
}

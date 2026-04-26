import { useEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { ensureReadableTextColor } from '../../helpers/chart-colors'
import { t } from '../../helpers/i18n'

interface Props {
  diagram: string
  title?: string | null
}

type MermaidTheme = {
  textColor: string
  lineColor: string
  primaryColor: string
  primaryTextColor: string
  primaryBorderColor: string
  secondaryColor: string
  tertiaryColor: string
  clusterBkg: string
  clusterBorder: string
  mainBkg: string
  nodeBorder: string
}

let mermaidModulePromise: Promise<{ default: typeof import('mermaid')['default'] }> | null = null

function loadMermaid() {
  mermaidModulePromise ||= import('mermaid') as Promise<{ default: typeof import('mermaid')['default'] }>
  return mermaidModulePromise
}

function sanitizeMermaidSvg(svg: string) {
  if (!DOMPurify.isSupported) return ''
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
  })
}

export function MermaidChart({ diagram, title }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [themeVersion, setThemeVersion] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => setThemeVersion((value) => value + 1))
    observer.observe(root, { attributes: true, attributeFilter: ['data-ui-theme', 'data-color-scheme'] })
    return () => observer.disconnect()
  }, [])

  const chartTheme = useMemo<MermaidTheme>(() => {
    const styles = getComputedStyle(document.documentElement)
    const surface = styles.getPropertyValue('--color-surface').trim() || '#1c1d26'
    const elevated = styles.getPropertyValue('--color-elevated').trim() || '#252633'
    const text = styles.getPropertyValue('--color-text').trim() || '#f1f3ff'
    const secondary = styles.getPropertyValue('--color-text-secondary').trim() || '#c3c7e8'
    const border = styles.getPropertyValue('--color-border').trim() || '#40465f'

    return {
      textColor: text,
      lineColor: secondary,
      primaryColor: elevated,
      primaryTextColor: text,
      primaryBorderColor: border,
      secondaryColor: surface,
      tertiaryColor: elevated,
      clusterBkg: surface,
      clusterBorder: border,
      mainBkg: surface,
      nodeBorder: border,
    }
  }, [themeVersion])

  function applyReadableLabelColors(svgNode: SVGSVGElement) {
    const defaultTextColor = ensureReadableTextColor(chartTheme.textColor, chartTheme.mainBkg)

    const setNodeTextColor = (root: Element, color: string) => {
      root.querySelectorAll('text, tspan').forEach((element) => {
        const node = element as SVGTextElement
        node.setAttribute('fill', color)
        node.style.fill = color
      })
      root.querySelectorAll('foreignObject, foreignObject *').forEach((element) => {
        const html = element as HTMLElement
        html.style.color = color
        html.style.fill = color
      })
    }

    const fillForElement = (element: Element | null) => {
      if (!element) return chartTheme.mainBkg
      const computed = getComputedStyle(element as Element)
      return computed.fill && computed.fill !== 'none'
        ? computed.fill
        : (computed.backgroundColor && computed.backgroundColor !== 'rgba(0, 0, 0, 0)'
          ? computed.backgroundColor
          : chartTheme.mainBkg)
    }

    svgNode.querySelectorAll('.node').forEach((node) => {
      const shape = node.querySelector('rect, polygon, circle, ellipse, path')
      const color = ensureReadableTextColor(chartTheme.textColor, fillForElement(shape))
      setNodeTextColor(node, color)
    })

    svgNode.querySelectorAll('.cluster').forEach((cluster) => {
      const shape = cluster.querySelector('rect, polygon, path')
      const color = ensureReadableTextColor(chartTheme.textColor, fillForElement(shape))
      setNodeTextColor(cluster, color)
    })

    svgNode.querySelectorAll('.edgeLabel').forEach((edgeLabel) => {
      setNodeTextColor(edgeLabel, defaultTextColor)
    })
  }

  useEffect(() => {
    if (!ref.current || !diagram) return

    let cancelled = false
    const container = ref.current
    container.innerHTML = ''
    setError(null)
    setZoom(1)
    setNaturalSize({ width: 0, height: 0 })

    async function render() {
      try {
        if (cancelled || !container) return

        const { default: mermaid } = await loadMermaid()
        if (cancelled) return

        const renderId = `open-cowork-mermaid-${Math.random().toString(36).slice(2)}`
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          themeVariables: chartTheme,
        })

        const { svg, bindFunctions } = await mermaid.render(renderId, diagram)
        if (cancelled) return

        const safeSvg = sanitizeMermaidSvg(svg)
        if (!safeSvg) throw new Error('Mermaid returned an unsafe SVG.')
        container.innerHTML = safeSvg
        bindFunctions?.(container)

        const svgNode = container.querySelector('svg')
        if (svgNode) {
          svgNode.style.display = 'block'
          svgNode.style.maxWidth = 'none'
          svgNode.style.height = 'auto'
          applyReadableLabelColors(svgNode)

          const viewBox = svgNode.viewBox?.baseVal
          const widthAttr = Number.parseFloat(svgNode.getAttribute('width') || '')
          const heightAttr = Number.parseFloat(svgNode.getAttribute('height') || '')
          const bbox = typeof svgNode.getBBox === 'function' ? svgNode.getBBox() : null
          const width = viewBox?.width || (Number.isFinite(widthAttr) ? widthAttr : 0) || bbox?.width || 0
          const height = viewBox?.height || (Number.isFinite(heightAttr) ? heightAttr : 0) || bbox?.height || 0

          if (width > 0 && height > 0) {
            setNaturalSize({ width, height })
          }
        }
      } catch (err: unknown) {
        console.error('[MermaidChart] Render error:', err)
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to render Mermaid diagram')
        }
      }
    }

    render()

    return () => {
      cancelled = true
      container.innerHTML = ''
    }
  }, [chartTheme, diagram])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const handleWheel = (event: WheelEvent) => {
      if (!event.metaKey && !event.ctrlKey) return
      event.preventDefault()

      setZoom((current) => {
        const delta = event.deltaY < 0 ? 0.1 : -0.1
        return Math.min(3, Math.max(0.5, Number((current + delta).toFixed(2))))
      })
    }

    viewport.addEventListener('wheel', handleWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', handleWheel)
  }, [])

  function adjustZoom(next: number) {
    setZoom(Math.min(3, Math.max(0.5, Number(next.toFixed(2)))))
  }

  if (error) {
    return (
      <div className="px-3 py-2 text-[11px] rounded-lg" style={{ color: 'var(--color-red)', background: 'color-mix(in srgb, var(--color-red) 10%, transparent)' }}>
        Mermaid error: {error}
      </div>
    )
  }

  return (
    <div className="my-1 rounded-lg overflow-hidden border border-border-subtle bg-surface px-3 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        {title ? (
          <div className="text-[12px] font-medium text-text-secondary">{title}</div>
        ) : <div />}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => adjustZoom(zoom - 0.1)}
            className="h-7 min-w-7 px-2 rounded-md border border-border-subtle text-[12px] text-text-secondary hover:bg-surface-hover cursor-pointer"
            aria-label={t('mermaid.zoomOut', 'Zoom out mermaid diagram')}
          >
            -
          </button>
          <button
            type="button"
            onClick={() => adjustZoom(1)}
            className="h-7 min-w-12 px-2 rounded-md border border-border-subtle text-[11px] text-text-secondary hover:bg-surface-hover cursor-pointer"
            aria-label={t('mermaid.resetZoom', 'Reset mermaid zoom')}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={() => adjustZoom(zoom + 0.1)}
            className="h-7 min-w-7 px-2 rounded-md border border-border-subtle text-[12px] text-text-secondary hover:bg-surface-hover cursor-pointer"
            aria-label={t('mermaid.zoomIn', 'Zoom in mermaid diagram')}
          >
            +
          </button>
        </div>
      </div>
      <div
        ref={viewportRef}
        className="w-full overflow-auto rounded-md"
        style={{ minHeight: 80, maxHeight: 560 }}
      >
        <div
          style={{
            width: naturalSize.width > 0 ? naturalSize.width * zoom : '100%',
            height: naturalSize.height > 0 ? naturalSize.height * zoom : 'auto',
          }}
        >
          <div
            ref={ref}
            style={{
              width: naturalSize.width > 0 ? naturalSize.width : '100%',
              transform: `scale(${zoom})`,
              transformOrigin: 'top left',
            }}
          />
        </div>
      </div>
    </div>
  )
}

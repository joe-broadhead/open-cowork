import { useEffect, useMemo, useRef, useState } from 'react'
import { ensureReadableTextColor } from '../../helpers/chart-colors'
import { applyVegaTheme, makeInteractiveVegaSpecResponsive, type VegaChartTheme } from './vega-chart-utils'

interface Props {
  spec: Record<string, unknown>
}

type ChartFrameMessage =
  | { type: 'chart-frame-ready' }
  | { type: 'chart-ready'; requestId: number; height: number }
  | { type: 'chart-error'; requestId: number; message: string }

const DEFAULT_FRAME_HEIGHT = 360
const FRAME_READY_TIMEOUT_MS = 3_000

export function VegaChart({ spec }: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const requestIdRef = useRef(0)
  const frameReadyTimeoutRef = useRef<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [themeVersion, setThemeVersion] = useState(0)
  const [frameLoaded, setFrameLoaded] = useState(false)
  const [frameReady, setFrameReady] = useState(false)
  const [frameHeight, setFrameHeight] = useState(DEFAULT_FRAME_HEIGHT)

  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => setThemeVersion((value) => value + 1))
    observer.observe(root, { attributes: true, attributeFilter: ['data-ui-theme', 'data-color-scheme'] })
    return () => observer.disconnect()
  }, [])

  const chartTheme = useMemo<VegaChartTheme>(() => {
    const styles = getComputedStyle(document.documentElement)
    const surface = styles.getPropertyValue('--color-surface').trim() || '#1c1d26'
    const text = styles.getPropertyValue('--color-text').trim() || '#f0f0f0'
    const textSecondary = styles.getPropertyValue('--color-text-secondary').trim() || '#a0a0aa'
    const textMuted = styles.getPropertyValue('--color-text-muted').trim() || '#8b8d99'
    return {
      axis: ensureReadableTextColor(textSecondary, surface),
      title: ensureReadableTextColor(text, surface),
      grid: styles.getPropertyValue('--color-border-subtle').trim() || 'rgba(255,255,255,0.08)',
      domain: styles.getPropertyValue('--color-border').trim() || 'rgba(255,255,255,0.12)',
      accent: styles.getPropertyValue('--color-accent').trim() || '#8da4f5',
      green: styles.getPropertyValue('--color-green').trim() || '#77c599',
      amber: styles.getPropertyValue('--color-amber').trim() || '#fc9b6f',
      red: styles.getPropertyValue('--color-red').trim() || '#fc92b4',
      info: styles.getPropertyValue('--color-info').trim() || '#77becf',
      muted: ensureReadableTextColor(textMuted, surface),
      secondary: ensureReadableTextColor(textSecondary, surface),
    }
  }, [themeVersion])

  const themedSpec = useMemo(() => {
    const themed = applyVegaTheme(spec, chartTheme)
    return makeInteractiveVegaSpecResponsive(themed)
  }, [chartTheme, spec])
  const frameSrc = useMemo(() => new URL('./chart-frame.html', window.location.href).toString(), [])

  useEffect(() => {
    const handleMessage = (event: MessageEvent<ChartFrameMessage>) => {
      const data = event.data
      if (!data || typeof data !== 'object' || !('type' in data)) return

      if (data.type === 'chart-frame-ready') {
        if (frameReadyTimeoutRef.current) {
          window.clearTimeout(frameReadyTimeoutRef.current)
          frameReadyTimeoutRef.current = null
        }
        setFrameReady(true)
        return
      }

      if (!('requestId' in data)) return
      if (data.requestId !== -1 && data.requestId !== requestIdRef.current) return

      if (data.type === 'chart-ready') {
        setError(null)
        setFrameHeight(Math.max(180, data.height))
      } else if (data.type === 'chart-error') {
        setError(data.message || 'Failed to render chart')
      }
    }

    window.addEventListener('message', handleMessage)
    return () => {
      window.removeEventListener('message', handleMessage)
      if (frameReadyTimeoutRef.current) {
        window.clearTimeout(frameReadyTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!frameLoaded || !frameReady || !iframeRef.current?.contentWindow) return

    requestIdRef.current += 1
    const requestId = requestIdRef.current
    setError(null)
    setFrameHeight(DEFAULT_FRAME_HEIGHT)

    iframeRef.current.contentWindow.postMessage({
      type: 'render-chart',
      requestId,
      spec: themedSpec,
    }, '*')
  }, [frameLoaded, frameReady, themedSpec])

  if (error) {
    return (
      <div className="px-3 py-2 text-[11px] rounded-lg" style={{ color: 'var(--color-red)', background: 'color-mix(in srgb, var(--color-red) 10%, transparent)' }}>
        Chart error: {error}
      </div>
    )
  }

  return (
    <div className="my-1 rounded-lg overflow-hidden w-full" style={{ minHeight: 50 }}>
      <iframe
        ref={iframeRef}
        title="Generated chart"
        src={frameSrc}
        sandbox="allow-scripts allow-same-origin"
        className="block w-full border-0 bg-transparent"
        style={{ height: `${frameHeight}px` }}
        onLoad={() => {
          setFrameLoaded(true)
          setFrameReady(false)
          setError(null)
          if (frameReadyTimeoutRef.current) {
            window.clearTimeout(frameReadyTimeoutRef.current)
          }
          frameReadyTimeoutRef.current = window.setTimeout(() => {
            setError('Chart frame did not initialize')
          }, FRAME_READY_TIMEOUT_MS)
        }}
      />
    </div>
  )
}

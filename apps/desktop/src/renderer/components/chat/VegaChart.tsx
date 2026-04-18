import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionArtifact } from '@open-cowork/shared'
import { useSessionStore } from '../../stores/session'
import { ensureReadableTextColor } from '../../helpers/chart-colors'
import { t } from '../../helpers/i18n'
import { applyVegaTheme, makeInteractiveVegaSpecResponsive, type VegaChartTheme } from './vega-chart-utils'

interface Props {
  spec: Record<string, unknown>
  // When these four props are provided, the chart is captured as a PNG
  // after the first successful render and persisted as a session
  // artifact. Downstream UI renders the existing artifact pill
  // (download + reveal) beneath the interactive chart. Omit any of
  // these (e.g. historical renders, previews) and the capture is
  // skipped — the chart is interactive-only.
  sessionId?: string | null
  toolCallId?: string
  toolName?: string
  taskRunId?: string | null
}

type ChartFrameMessage =
  | { type: 'chart-frame-ready' }
  | { type: 'chart-ready'; requestId: number; height: number }
  | { type: 'chart-error'; requestId: number; message: string }
  | { type: 'chart-capture'; requestId: number; dataUrl: string }
  | { type: 'chart-capture-error'; requestId: number; message: string }

const DEFAULT_FRAME_HEIGHT = 360
const FRAME_READY_TIMEOUT_MS = 3_000

export function VegaChart({ spec, sessionId, toolCallId, toolName, taskRunId }: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const requestIdRef = useRef(0)
  const captureRequestIdRef = useRef(0)
  const capturedForSpecRef = useRef<string | null>(null)
  const frameReadyTimeoutRef = useRef<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [themeVersion, setThemeVersion] = useState(0)
  const [frameLoaded, setFrameLoaded] = useState(false)
  const [frameReady, setFrameReady] = useState(false)
  const [frameHeight, setFrameHeight] = useState(DEFAULT_FRAME_HEIGHT)
  const [artifact, setArtifact] = useState<SessionArtifact | null>(null)
  const [exportingArtifact, setExportingArtifact] = useState(false)
  const registerChartArtifact = useSessionStore((state) => state.registerChartArtifact)

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

  const canCapture = Boolean(sessionId && toolCallId && toolName)
  const specSignature = useMemo(() => {
    // Keyed on the spec object identity + toolCallId so a new render
    // request (e.g. re-run of the same tool with different data)
    // triggers a fresh capture, while re-mounting with the same spec
    // doesn't re-capture needlessly.
    return toolCallId || null
  }, [toolCallId])

  const requestCapture = () => {
    if (!canCapture) return
    if (capturedForSpecRef.current === specSignature) return
    if (!iframeRef.current?.contentWindow) return

    captureRequestIdRef.current += 1
    const requestId = captureRequestIdRef.current
    const iframeSrc = iframeRef.current.src || ''
    let targetOrigin = window.location.origin
    try {
      if (iframeSrc) targetOrigin = new URL(iframeSrc, window.location.href).origin
    } catch {
      /* fall back */
    }
    iframeRef.current.contentWindow.postMessage({
      type: 'capture-chart',
      requestId,
      scale: 2,
    }, targetOrigin)
  }

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

      if (data.type === 'chart-capture') {
        if (data.requestId !== captureRequestIdRef.current) return
        if (!sessionId || !toolCallId || !toolName) return
        capturedForSpecRef.current = specSignature
        void window.coworkApi.chart.saveArtifact({
          sessionId,
          toolCallId,
          toolName,
          taskRunId: taskRunId || null,
          dataUrl: data.dataUrl,
        })
          .then((saved) => {
            setArtifact(saved)
            registerChartArtifact(sessionId, saved)
          })
          .catch(() => {
            // Non-fatal — the interactive chart still works; leaving the
            // ref set so we don't retry-spam on every frame update.
          })
        return
      }

      if (data.type === 'chart-capture-error') {
        if (data.requestId !== captureRequestIdRef.current) return
        capturedForSpecRef.current = specSignature
        return
      }

      if (data.requestId !== -1 && data.requestId !== requestIdRef.current) return

      if (data.type === 'chart-ready') {
        setError(null)
        setFrameHeight(Math.max(180, data.height))
        // Kick off a capture the first time we see a chart-ready that
        // matches the current spec. Debounced via capturedForSpecRef so
        // the ResizeObserver-driven repeat chart-ready messages don't
        // hammer the capture path.
        requestCapture()
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
  }, [canCapture, registerChartArtifact, sessionId, specSignature, taskRunId, toolCallId, toolName])

  useEffect(() => {
    if (!frameLoaded || !frameReady || !iframeRef.current?.contentWindow) return

    requestIdRef.current += 1
    const requestId = requestIdRef.current
    setError(null)
    setFrameHeight(DEFAULT_FRAME_HEIGHT)

    // Post to the frame's own origin rather than `"*"` so a compromised
    // or hijacked cross-origin listener inside the iframe can't intercept
    // the spec. In Electron packaged builds the frame is served via
    // `file://`; in dev it's the vite dev server. `iframeRef.src` holds
    // either URL and we can derive the target origin from it.
    const iframeSrc = iframeRef.current.src || ''
    let targetOrigin = window.location.origin
    try {
      if (iframeSrc) targetOrigin = new URL(iframeSrc, window.location.href).origin
    } catch {
      // Non-URL src (e.g. data:); fall back to the renderer's own origin.
    }
    iframeRef.current.contentWindow.postMessage({
      type: 'render-chart',
      requestId,
      spec: themedSpec,
    }, targetOrigin)
  }, [frameLoaded, frameReady, themedSpec])

  if (error) {
    return (
      <div className="px-3 py-2 text-[11px] rounded-lg" style={{ color: 'var(--color-red)', background: 'color-mix(in srgb, var(--color-red) 10%, transparent)' }}>
        Chart error: {error}
      </div>
    )
  }

  const onExportArtifact = async () => {
    if (!artifact || !sessionId) return
    setExportingArtifact(true)
    try {
      await window.coworkApi.artifact.export({ sessionId, filePath: artifact.filePath })
    } finally {
      setExportingArtifact(false)
    }
  }

  const onRevealArtifact = async () => {
    if (!artifact || !sessionId) return
    await window.coworkApi.artifact.reveal({ sessionId, filePath: artifact.filePath })
  }

  return (
    <div className="my-1 rounded-lg overflow-hidden w-full" style={{ minHeight: 50 }}>
      {/* onLoad on <iframe> is a lifecycle event, not a mouse/keyboard
          interaction — the a11y lint rule for "non-interactive
          elements should not have mouse/key listeners" is a false
          positive here. The iframe is a chart viewer; keyboard users
          interact with the chart via the surrounding chat UI. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <iframe
        ref={iframeRef}
        title={t('chart.generatedChart', 'Generated chart')}
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
      {artifact ? (
        <div className="mt-1 flex items-center justify-between gap-3 px-3 py-2 border-t border-border-subtle text-[11px]">
          <div className="min-w-0 flex items-center gap-2">
            <span className="text-[9px] uppercase tracking-[0.08em] text-text-muted">{t('chart.savedAs', 'Saved as')}</span>
            <span className="font-mono truncate text-text-secondary">{artifact.filename}</span>
          </div>
          <div className="shrink-0 flex items-center gap-1.5">
            <button
              onClick={() => void onRevealArtifact()}
              className="px-2 py-0.5 rounded border border-border-subtle text-[10px] text-text-secondary hover:text-text hover:bg-surface-hover cursor-pointer"
            >
              Reveal
            </button>
            <button
              onClick={() => void onExportArtifact()}
              disabled={exportingArtifact}
              className="px-2 py-0.5 rounded border border-border-subtle text-[10px] text-text-secondary hover:text-text hover:bg-surface-hover cursor-pointer disabled:opacity-40"
            >
              {exportingArtifact ? 'Saving…' : 'Save As…'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

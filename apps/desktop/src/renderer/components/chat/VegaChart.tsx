import { useEffect, useMemo, useRef, useState } from 'react'
import { ensureReadableTextColor } from '../../helpers/chart-colors'
import { isFullVegaSpec, normalizeVegaSpecSchema } from './vega-chart-utils'

interface Props {
  spec: Record<string, unknown>
}

export function VegaChart({ spec }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [themeVersion, setThemeVersion] = useState(0)

  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => setThemeVersion((value) => value + 1))
    observer.observe(root, { attributes: true, attributeFilter: ['data-ui-theme', 'data-color-scheme'] })
    return () => observer.disconnect()
  }, [])

  const chartTheme = useMemo(() => {
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

  const normalizedSpec = useMemo(() => normalizeVegaSpecSchema(spec), [spec])
  const fullVegaSpec = useMemo(() => isFullVegaSpec(normalizedSpec), [normalizedSpec])

  useEffect(() => {
    if (!ref.current || !normalizedSpec) return

    let cancelled = false

    async function render() {
      try {
        const vegaEmbed = await import('vega-embed')
        const embed = vegaEmbed.default || vegaEmbed

        if (cancelled || !ref.current) return

        const fullSpec = fullVegaSpec
          ? {
              ...normalizedSpec,
              background: 'transparent',
              config: {
                ...(typeof normalizedSpec.config === 'object' && normalizedSpec.config ? normalizedSpec.config : {}),
                axis: {
                  labelColor: chartTheme.axis,
                  titleColor: chartTheme.axis,
                  gridColor: chartTheme.grid,
                  domainColor: chartTheme.domain,
                  labelFontSize: 11,
                  titleFontSize: 12,
                },
                legend: { labelColor: chartTheme.axis, titleColor: chartTheme.axis, labelFontSize: 11 },
                title: { color: chartTheme.title, fontSize: 14, fontWeight: 600 },
                view: { stroke: 'transparent' },
                mark: { color: chartTheme.accent },
                range: {
                  category: [
                    chartTheme.accent,
                    chartTheme.green,
                    chartTheme.amber,
                    chartTheme.red,
                    chartTheme.info,
                    chartTheme.secondary,
                    chartTheme.muted,
                    chartTheme.accent,
                    chartTheme.green,
                    chartTheme.amber,
                  ],
                },
              },
            }
          : {
              ...normalizedSpec,
              width: 'container' as any,
              autosize: { type: 'fit', contains: 'padding' },
              background: 'transparent',
              config: {
                ...(typeof normalizedSpec.config === 'object' && normalizedSpec.config ? normalizedSpec.config : {}),
                axis: {
                  labelColor: chartTheme.axis,
                  titleColor: chartTheme.axis,
                  gridColor: chartTheme.grid,
                  domainColor: chartTheme.domain,
                  labelFontSize: 11,
                  titleFontSize: 12,
                },
                legend: { labelColor: chartTheme.axis, titleColor: chartTheme.axis, labelFontSize: 11 },
                title: { color: chartTheme.title, fontSize: 14, fontWeight: 600 },
                view: { stroke: 'transparent' },
                mark: { color: chartTheme.accent },
                range: {
                  category: [
                    chartTheme.accent,
                    chartTheme.green,
                    chartTheme.amber,
                    chartTheme.red,
                    chartTheme.info,
                    chartTheme.secondary,
                    chartTheme.muted,
                    chartTheme.accent,
                    chartTheme.green,
                    chartTheme.amber,
                  ],
                },
              },
            }

        const result = await embed(ref.current!, fullSpec as any, {
          actions: { export: true, source: false, compiled: false, editor: false },
          theme: 'dark' as any,
          renderer: 'svg',
        })

        if (cancelled) result.finalize()
      } catch (err: any) {
        console.error('[VegaChart] Render error:', err)
        setError(err?.message || 'Failed to render chart')
      }
    }

    render()

    return () => { cancelled = true }
  }, [chartTheme, fullVegaSpec, normalizedSpec])

  if (error) {
    return (
      <div className="px-3 py-2 text-[11px] rounded-lg" style={{ color: 'var(--color-red)', background: 'color-mix(in srgb, var(--color-red) 10%, transparent)' }}>
        Chart error: {error}
      </div>
    )
  }

  return (
    <div ref={ref} className="my-1 rounded-lg overflow-hidden w-full" style={{ minHeight: 50 }} />
  )
}

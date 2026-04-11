import { useRef, useEffect, useState } from 'react'

interface Props {
  spec: Record<string, unknown>
}

export function VegaChart({ spec }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!ref.current || !spec) return

    let cancelled = false

    async function render() {
      try {
        const vegaEmbed = await import('vega-embed')
        const embed = vegaEmbed.default || vegaEmbed

        if (cancelled || !ref.current) return

        const fullSpec = {
          ...spec,
          width: 'container' as any,
          autosize: { type: 'fit', contains: 'padding' },
          background: 'transparent',
          config: {
            axis: { labelColor: '#999', titleColor: '#bbb', gridColor: '#2a2a2a', domainColor: '#444', labelFontSize: 11, titleFontSize: 12 },
            legend: { labelColor: '#999', titleColor: '#bbb', labelFontSize: 11 },
            title: { color: '#e5e5e5', fontSize: 14, fontWeight: 600 },
            view: { stroke: 'transparent' },
            mark: { color: '#4f8ff7' },
            range: { category: ['#4f8ff7', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#fb923c', '#38bdf8', '#e879f9', '#94a3b8', '#6ee7b7'] },
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
  }, [spec])

  if (error) {
    return (
      <div className="px-3 py-2 text-[11px] rounded-lg" style={{ color: 'var(--color-red)', background: 'rgba(255,0,0,0.05)' }}>
        Chart error: {error}
      </div>
    )
  }

  return (
    <div ref={ref} className="my-1 rounded-lg overflow-hidden w-full" style={{ minHeight: 50 }} />
  )
}

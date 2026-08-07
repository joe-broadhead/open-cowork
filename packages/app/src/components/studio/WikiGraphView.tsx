import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WikiGraph, WikiGraphEdge, WikiGraphNode } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import { Button } from '@open-cowork/ui'

const PAGE_KINDS = new Set(['page'])
const LINK_KINDS = new Set(['page_link', 'page_typed_link'])

const NODE_COLORS: Record<string, string> = {
  page: '#38bdf8',
  source: '#a78bfa',
  claim: '#f472b6',
  topic: '#34d399',
  proposal: '#fbbf24',
  decision: '#f87171',
  default: '#94a3b8',
}

function nodeColor(recordType: string): string {
  return NODE_COLORS[recordType] ?? '#94a3b8'
}

interface PositionedNode {
  node: WikiGraphNode
  x: number
  y: number
}

/** Deterministic force-directed layout over the visible subgraph. */
function layoutGraph(
  nodes: WikiGraphNode[],
  edges: WikiGraphEdge[],
  width: number,
  height: number,
): PositionedNode[] {
  if (nodes.length === 0) return []
  const positions: PositionedNode[] = nodes.map((node, index) => {
    const angle = (2 * Math.PI * index) / nodes.length
    const radius = Math.min(width, height) * 0.32
    return { node, x: width / 2 + Math.cos(angle) * radius, y: height / 2 + Math.sin(angle) * radius }
  })
  if (nodes.length < 2) return positions

  const byId = new Map<string, PositionedNode>()
  positions.forEach((p) => byId.set(p.node.id, p))

  const repulsion = 5200
  const springLength = 150
  const springStrength = 0.06
  const centreStrength = 0.012

  for (let iter = 0; iter < 260; iter += 1) {
    for (let i = 0; i < positions.length; i += 1) {
      for (let j = i + 1; j < positions.length; j += 1) {
        const a = positions[i]!
        const b = positions[j]!
        let dx = a.x - b.x
        let dy = a.y - b.y
        if (dx === 0 && dy === 0) {
          dx = Math.random() - 0.5
          dy = Math.random() - 0.5
        }
        const dist = Math.max(Math.hypot(dx, dy), 30)
        const force = repulsion / (dist * dist)
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        a.x += fx
        a.y += fy
        b.x -= fx
        b.y -= fy
      }
    }
    for (const edge of edges) {
      const a = byId.get(edge.fromId)
      const b = byId.get(edge.toId)
      if (!a || !b) continue
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.max(Math.hypot(dx, dy), 0.01)
      const force = (dist - springLength) * springStrength
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      a.x += fx
      a.y += fy
      b.x -= fx
      b.y -= fy
    }
    for (const p of positions) {
      p.x += (width / 2 - p.x) * centreStrength
      p.y += (height / 2 - p.y) * centreStrength
    }
  }
  return positions
}

function pickSubgraph(
  graph: WikiGraph,
  pagesOnly: boolean,
  query: string,
): { nodes: WikiGraphNode[]; edges: WikiGraphEdge[] } {
  let nodes = graph.nodes
  let edges = graph.edges
  if (pagesOnly) {
    nodes = nodes.filter((n) => PAGE_KINDS.has(n.recordType))
    edges = edges.filter((e) => LINK_KINDS.has(e.edgeType))
  }
  const q = query.trim().toLowerCase()
  if (q) {
    const matched = new Set<string>()
    nodes.forEach((n) => {
      if (n.title.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)) matched.add(n.id)
    })
    edges = edges.filter((e) => matched.has(e.fromId) && matched.has(e.toId))
    nodes = nodes.filter((n) => matched.has(n.id))
  }
  return { nodes, edges }
}

interface ViewTransform {
  zoom: number
  x: number
  y: number
}

export function WikiGraphView({
  graph,
  selectedId,
  onSelect,
  className = '',
}: {
  graph: WikiGraph
  selectedId: string | null
  onSelect: (id: string) => void
  className?: string
}) {
  const [pagesOnly, setPagesOnly] = useState(true)
  const [query, setQuery] = useState('')
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const viewRef = useRef<ViewTransform>({ zoom: 1, x: 0, y: 0 })
  const dragRef = useRef<{ mode: 'node' | 'pan' | 'none'; id: string | null; moved: boolean; lastX: number; lastY: number }>({
    mode: 'none', id: null, moved: false, lastX: 0, lastY: 0,
  })
  const hoverRef = useRef<string | null>(null)
  const [, forceTick] = useState(0)

  // Measure the wrapper.
  useEffect(() => {
    const measure = () => {
      const el = wrapperRef.current
      if (!el) return
      setDimensions({ width: el.clientWidth, height: el.clientHeight })
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (wrapperRef.current) ro.observe(wrapperRef.current)
    return () => ro.disconnect()
  }, [])

  const sub = useMemo(() => pickSubgraph(graph, pagesOnly, query), [graph, pagesOnly, query])

  const positioned = useMemo(
    () => layoutGraph(sub.nodes, sub.edges, Math.max(dimensions.width, 300), Math.max(dimensions.height, 300)),
    [sub, dimensions.width, dimensions.height],
  )
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map())
  positionsRef.current = new Map(positioned.map((p) => [p.node.id, { x: p.x, y: p.y }]))

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx || dimensions.width <= 0 || dimensions.height <= 0) return
    const dpr = window.devicePixelRatio || 1
    const w = dimensions.width
    const h = dimensions.height
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const { zoom, x, y } = viewRef.current
    const toX = (px: number) => px * zoom + x
    const toY = (py: number) => py * zoom + y

    // Normalize positions into a local map.
    const posMap = positionsRef.current

    const focus = selectedId
    const neighbours = new Set<string>()
    if (focus) {
      for (const e of sub.edges) {
        if (e.fromId === focus) neighbours.add(e.toId)
        if (e.toId === focus) neighbours.add(e.fromId)
      }
    }

    // Edges.
    for (const edge of sub.edges) {
      const a = posMap.get(edge.fromId)
      const b = posMap.get(edge.toId)
      if (!a || !b) continue
      let alpha = 0.3
      if (focus) {
        if (edge.fromId === focus || edge.toId === focus) alpha = 0.9
        else if (neighbours.has(edge.fromId) && neighbours.has(edge.toId)) alpha = 0.35
        else alpha = 0.08
      }
      ctx.strokeStyle = pagesOnly ? '#334155' : '#475569'
      ctx.globalAlpha = alpha
      ctx.lineWidth = Math.max(1, 1.15 * zoom)
      ctx.beginPath()
      ctx.moveTo(toX(a.x), toY(a.y))
      ctx.lineTo(toX(b.x), toY(b.y))
      ctx.stroke()
    }

    // Nodes + labels.
    for (const p of positioned) {
      const isFocus = p.node.id === focus
      const isNeighbour = focus ? neighbours.has(p.node.id) : false
      const rad = ((p.node.recordType === 'page' ? 7 : 6) * zoom) / Math.max(zoom, 0.3)
      const sx = toX(p.x)
      const sy = toY(p.y)
      ctx.globalAlpha = focus && !isFocus && !isNeighbour ? 0.22 : 1
      ctx.beginPath()
      ctx.arc(sx, sy, rad, 0, Math.PI * 2)
      ctx.fillStyle = nodeColor(p.node.recordType)
      ctx.fill()
      if (isFocus) {
        ctx.strokeStyle = '#f8fafc'
        ctx.lineWidth = 2
        ctx.stroke()
      } else if (p.node.id === hoverRef.current) {
        ctx.strokeStyle = 'rgba(248,250,252,0.7)'
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1

    for (const p of positioned) {
      const isFocus = p.node.id === focus
      const isNeighbour = focus ? neighbours.has(p.node.id) : false
      if (p.node.recordType !== 'page' && !isFocus && !isNeighbour && zoom < 0.6) continue
      ctx.globalAlpha = focus && !isFocus && !isNeighbour ? 0.25 : 0.92
      ctx.font = isFocus ? '600 12px ui-sans-serif, system-ui' : '11px ui-sans-serif, system-ui'
      ctx.fillStyle = '#cbd5e1'
      const label = (p.node.title && p.node.title.trim()) || p.node.id
      ctx.fillText(label, toX(p.x) + (zoom >= 0.6 ? 8 : 4), toY(p.y) + 4)
    }
    ctx.globalAlpha = 1
  }, [positioned, sub.edges, dimensions.width, dimensions.height, pagesOnly, selectedId])

  useEffect(() => {
    const raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [draw, positioned])

  const nodeAtScreen = (sx: number, sy: number): string | null => {
    const { zoom, x, y } = viewRef.current
    let best: string | null = null
    let bestDist = 26 + (6 * zoom) / Math.max(zoom, 0.3)
    for (const p of positioned) {
      const dx = p.x * zoom + x - sx
      const dy = p.y * zoom + y - sy
      const d = Math.hypot(dx, dy)
      if (d < bestDist) {
        bestDist = d
        best = p.node.id
      }
    }
    return best
  }

  const zoomAt = (factor: number, cx: number, cy: number) => {
    const v = viewRef.current
    const next = Math.min(4, Math.max(0.2, v.zoom * factor))
    if (next === v.zoom) return
    const worldX = (cx - v.x) / v.zoom
    const worldY = (cy - v.y) / v.zoom
    v.zoom = next
    v.x = cx - worldX * next
    v.y = cy - worldY * next
    forceTick((t) => t + 1)
  }

  const fitView = () => {
    const v = viewRef.current
    if (positioned.length === 0) return
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of positioned) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
    const w = dimensions.width || 600
    const h = dimensions.height || 400
    const pad = 60
    const zoom = Math.min((w - pad * 2) / Math.max(maxX - minX, 1), (h - pad * 2) / Math.max(maxY - minY, 1), 1.4)
    v.zoom = Math.max(0.2, zoom)
    v.x = w / 2 - ((minX + maxX) / 2) * v.zoom
    v.y = h / 2 - ((minY + maxY) / 2) * v.zoom
    forceTick((t) => t + 1)
  }

  const screenPos = (event: React.PointerEvent | PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { sx: event.clientX - rect.left, sy: event.clientY - rect.top }
  }

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const { sx, sy } = screenPos(event)
    const hit = nodeAtScreen(sx, sy)
    dragRef.current = { mode: hit ? 'node' : 'pan', id: hit, moved: false, lastX: sx, lastY: sy }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const { sx, sy } = screenPos(event)
    const hit = nodeAtScreen(sx, sy)
    if (hoverRef.current !== hit) {
      hoverRef.current = hit
      forceTick((t) => t + 1)
    }
    const drag = dragRef.current
    if (drag.mode === 'node' && drag.id) {
      const moved = Math.hypot(sx - drag.lastX, sy - drag.lastY)
      if (moved > 3) drag.moved = true
      if (drag.moved) {
        const pos = positionsRef.current.get(drag.id)
        if (pos) {
          pos.x += (sx - drag.lastX) / viewRef.current.zoom
          pos.y += (sy - drag.lastY) / viewRef.current.zoom
        }
      }
    } else if (drag.mode === 'pan') {
      const moved = Math.hypot(sx - drag.lastX, sy - drag.lastY)
      if (moved > 2) {
        drag.moved = true
        viewRef.current.x += sx - drag.lastX
        viewRef.current.y += sy - drag.lastY
      }
    }
    if (drag.mode !== 'none') {
      drag.lastX = sx
      drag.lastY = sy
      forceTick((t) => t + 1)
    }
  }

  const endDrag = () => {
    const drag = dragRef.current
    if (drag.mode === 'node' && drag.id && !drag.moved) {
      onSelect(drag.id)
    }
    dragRef.current = { mode: 'none', id: null, moved: false, lastX: 0, lastY: 0 }
  }

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const { sx, sy } = screenPos(event as unknown as PointerEvent)
    zoomAt(event.deltaY > 0 ? 0.9 : 1.1, sx, sy)
  }

  return (
    <div className={`flex min-h-0 flex-col gap-3 ${className}`}>
      <div className="flex w-full flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('wiki.graph.search', 'Filter graph…')}
          className="w-56 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text placeholder:text-text-muted"
        />
        <label className="flex items-center gap-2 text-2xs text-text-muted">
          <input type="checkbox" checked={pagesOnly} onChange={(event) => setPagesOnly(event.target.checked)} />
          {t('wiki.graph.pagesOnly', 'Pages only')}
        </label>
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="secondary" onClick={() => zoomAt(1.2, dimensions.width / 2, dimensions.height / 2)}>+</Button>
          <Button size="sm" variant="secondary" onClick={() => zoomAt(0.8, dimensions.width / 2, dimensions.height / 2)}>−</Button>
          <Button size="sm" variant="secondary" onClick={fitView}>{t('wiki.graph.fit', 'Fit')}</Button>
        </div>
      </div>
      <div ref={wrapperRef} className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-surface">
        {dimensions.width > 0 && positioned.length === 0 ? (
          <div className="grid h-full place-items-center text-2xs text-text-muted">
            {t('wiki.graph.empty', 'No graph nodes to show.', )}
          </div>
        ) : null}
        <canvas
          ref={canvasRef}
          className="absolute inset-0 block touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
          onWheel={onWheel}
        />
      </div>
    </div>
  )
}

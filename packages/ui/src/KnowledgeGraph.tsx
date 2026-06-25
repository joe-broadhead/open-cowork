import { useMemo, useState } from 'react'
import { computeKnowledgeGraphLayout, type KnowledgeGraph as KnowledgeGraphData } from '@open-cowork/shared'
import { EmptyState } from './EmptyState.js'
import { knowledgeSpaceHue } from './knowledge-hues.js'

function hueForSpace(spaceIndex: number) {
  return knowledgeSpaceHue(spaceIndex)
}

function truncateLabel(label: string, max = 26) {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label
}

export type KnowledgeGraphProps = {
  graph: KnowledgeGraphData
  selectedPageId?: string | null
  onSelectPage: (pageId: string) => void
}

/**
 * The knowledge graph: a full-height SVG clustering every page by its Space —
 * a central root, Spaces orbiting it, pages fanned around each Space, with an
 * edge drawn for every link (containment + page↔page backlinks). Hovering a
 * node traces its directly-linked neighbours in accent and dims the rest;
 * clicking a page opens it. Shared by the desktop renderer and Cloud Web so
 * both draw an identical graph.
 */
export function KnowledgeGraph({ graph, selectedPageId = null, onSelectPage }: KnowledgeGraphProps) {
  const layout = useMemo(() => computeKnowledgeGraphLayout(graph), [graph])
  const [hovered, setHovered] = useState<string | null>(null)

  const nodeById = useMemo(() => new Map(layout.nodes.map((node) => [node.id, node])), [layout.nodes])

  // Per-Space colour key, in node order so the legend hues match the graph.
  const legendSpaces = useMemo(() => {
    const seen = new Map<number, string>()
    for (const node of layout.nodes) {
      if (node.kind === 'space' && !seen.has(node.spaceIndex)) seen.set(node.spaceIndex, node.label)
    }
    return [...seen.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([spaceIndex, label]) => ({ spaceIndex, label, hue: hueForSpace(spaceIndex) }))
  }, [layout.nodes])

  const neighbours = useMemo(() => {
    if (!hovered) return null
    const set = new Set<string>([hovered])
    for (const edge of layout.edges) {
      if (edge.source === hovered) set.add(edge.target)
      if (edge.target === hovered) set.add(edge.source)
    }
    return set
  }, [hovered, layout.edges])

  const isDim = (id: string) => neighbours !== null && !neighbours.has(id)

  if (!layout.nodes.length) {
    return (
      <div className="studio-graph studio-graph--empty">
        <EmptyState
          icon="search"
          title="No graph nodes loaded"
          body="Knowledge spaces and pages appear here once the workspace has been indexed."
        />
      </div>
    )
  }

  return (
    <div className="studio-graph-panel">
      {legendSpaces.length > 0 ? (
        <div className="studio-graph-legend" aria-label="Spaces">
          {legendSpaces.map((space) => (
            <span key={space.spaceIndex} className="studio-graph-legend-item">
              <span className="studio-graph-legend-dot" style={{ background: space.hue }} aria-hidden="true" />
              {truncateLabel(space.label, 22)}
            </span>
          ))}
        </div>
      ) : null}
      <div className="studio-graph">
        <svg
          className="studio-graph-svg"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Knowledge graph"
      >
        <g>
          {layout.edges.map((edge) => {
            const a = nodeById.get(edge.source)
            const b = nodeById.get(edge.target)
            if (!a || !b) return null
            const active = hovered != null && (edge.source === hovered || edge.target === hovered)
            return (
              <line
                key={edge.id}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={active ? 'var(--color-accent)' : 'var(--color-border-strong)'}
                strokeWidth={active ? 1.6 : 1}
                opacity={hovered ? (active ? 0.9 : 0.12) : 0.5}
              />
            )
          })}
        </g>
        <g>
          {layout.nodes.map((node) => {
            const hue = hueForSpace(node.spaceIndex)
            const isPage = node.kind === 'page'
            const selected = isPage && node.pageId != null && node.pageId === selectedPageId
            const interactive = node.pageId != null
            return (
              <g
                key={node.id}
                className="studio-graph-node"
                data-kind={node.kind}
                data-dim={isDim(node.id) ? 'true' : undefined}
                data-selected={selected ? 'true' : undefined}
                onMouseEnter={() => setHovered(node.id)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(node.id)}
                onBlur={() => setHovered(null)}
                onClick={() => interactive && onSelectPage(node.pageId as string)}
                onKeyDown={interactive
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onSelectPage(node.pageId as string)
                      }
                    }
                  : undefined}
                style={{ cursor: interactive ? 'pointer' : 'default' }}
                tabIndex={interactive ? 0 : -1}
                role={interactive ? 'button' : undefined}
                aria-label={interactive ? node.label : undefined}
              >
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={node.r}
                  fill={hue}
                  stroke={node.kind === 'root' || selected ? 'var(--color-accent)' : 'var(--color-surface)'}
                  strokeWidth={node.kind === 'page' ? (selected ? 3 : 2) : 2.5}
                />
                <text
                  x={node.x}
                  y={node.y + node.r + (isPage ? 14 : 18)}
                  textAnchor="middle"
                  className="studio-graph-label"
                  fontSize={isPage ? 12 : 13}
                  fontWeight={isPage ? 500 : 700}
                >
                  {isPage ? truncateLabel(node.label) : node.label}
                </text>
              </g>
            )
          })}
        </g>
        </svg>
      </div>
    </div>
  )
}

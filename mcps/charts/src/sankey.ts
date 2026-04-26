const VEGA_SCHEMA = 'https://vega.github.io/schema/vega/v5.json'

type SankeyRecord = Record<string, unknown>

type SankeyInput = {
  data: SankeyRecord[]
  source: string
  target: string
  value: string
  title: string
  width: number
  height: number
  nodeWidth: number
  nodePadding: number
}

type SankeyNode = {
  id: string
  label: string
  column: number
  value: number
  x0: number
  x1: number
  y0: number
  y1: number
  fill: string
  labelColor: string
  labelSide: 'left' | 'right'
  labelAlign: 'left' | 'right'
}

type SankeyLink = {
  source: string
  target: string
  value: number
  sourceLabel: string
  targetLabel: string
  path: string
  width: number
  stroke: string
}

const DEFAULT_LABEL_COLOR = '#231f33'
const MAX_SANKEY_NODES = 1_000
const SANKEY_PALETTE = [
  '#c8e6ff',
  '#f0dcff',
  '#d9f0d2',
  '#ffd7d7',
  '#ffe6bf',
  '#d7f3ee',
  '#fff0c7',
  '#dfdefb',
  '#f6d3ff',
  '#e2f0ff',
]

function toPositiveNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function toLabel(value: unknown) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function pathBetween(sourceX: number, sourceY: number, targetX: number, targetY: number) {
  const delta = Math.max(24, (targetX - sourceX) * 0.45)
  return `M ${sourceX},${sourceY} C ${sourceX + delta},${sourceY} ${targetX - delta},${targetY} ${targetX},${targetY}`
}

export function buildSankeySpec(input: SankeyInput) {
  const { data, source, target, value, title } = input
  const width = Math.max(320, input.width)
  const height = Math.max(240, input.height)
  const nodeWidth = Math.max(8, input.nodeWidth)
  const nodePadding = Math.max(8, input.nodePadding)
  const topInset = 8
  const drawableHeight = Math.max(120, height - topInset)

  const aggregatedLinks = new Map<string, { source: string; target: string; value: number }>()

  for (const row of data) {
    const sourceLabel = toLabel(row[source])
    const targetLabel = toLabel(row[target])
    const numericValue = toPositiveNumber(row[value])
    if (!sourceLabel || !targetLabel || numericValue === null || numericValue <= 0) continue
    const key = `${sourceLabel}\u0000${targetLabel}`
    const existing = aggregatedLinks.get(key)
    if (existing) {
      existing.value += numericValue
    } else {
      aggregatedLinks.set(key, { source: sourceLabel, target: targetLabel, value: numericValue })
    }
  }

  const rawLinks = Array.from(aggregatedLinks.values())
  if (rawLinks.length === 0) {
    throw new Error('Sankey charts require at least one row with valid source, target, and positive value fields.')
  }

  const nodeIds = Array.from(new Set(rawLinks.flatMap((link) => [link.source, link.target])))
  if (nodeIds.length > MAX_SANKEY_NODES) {
    throw new Error(`Sankey charts support at most ${MAX_SANKEY_NODES} unique nodes; received ${nodeIds.length}.`)
  }
  const incomingCount = new Map<string, number>(nodeIds.map((id) => [id, 0]))
  const outgoingBySource = new Map<string, typeof rawLinks>()

  for (const link of rawLinks) {
    incomingCount.set(link.target, (incomingCount.get(link.target) || 0) + 1)
    const outgoing = outgoingBySource.get(link.source) || []
    outgoing.push(link)
    outgoingBySource.set(link.source, outgoing)
  }

  const columns = new Map<string, number>(nodeIds.map((id) => [id, 0]))
  const indegree = new Map(incomingCount)
  const queue = nodeIds.filter((id) => (incomingCount.get(id) || 0) === 0)
  const processed = new Set<string>()

  while (queue.length > 0) {
    const nodeId = queue.shift()!
    processed.add(nodeId)
    const sourceColumn = columns.get(nodeId) || 0
    for (const link of outgoingBySource.get(nodeId) || []) {
      const nextColumn = Math.max(columns.get(link.target) || 0, sourceColumn + 1)
      columns.set(link.target, nextColumn)
      const remaining = (indegree.get(link.target) || 0) - 1
      indegree.set(link.target, remaining)
      if (remaining === 0) {
        queue.push(link.target)
      }
    }
  }

  const sourceSum = new Map<string, number>(nodeIds.map((id) => [id, 0]))
  const targetSum = new Map<string, number>(nodeIds.map((id) => [id, 0]))
  for (const link of rawLinks) {
    sourceSum.set(link.source, (sourceSum.get(link.source) || 0) + link.value)
    targetSum.set(link.target, (targetSum.get(link.target) || 0) + link.value)
  }

  const nodesByColumn = new Map<number, SankeyNode[]>()
  const maxColumn = Math.max(...Array.from(columns.values()))
  const stepX = maxColumn > 0 ? (width - nodeWidth) / maxColumn : 0

  nodeIds.forEach((id, index) => {
    const column = columns.get(id) || 0
    const valueSum = Math.max(sourceSum.get(id) || 0, targetSum.get(id) || 0, 1)
    const node: SankeyNode = {
      id,
      label: id,
      column,
      value: valueSum,
      x0: column * stepX,
      x1: column * stepX + nodeWidth,
      y0: 0,
      y1: 0,
      fill: SANKEY_PALETTE[index % SANKEY_PALETTE.length],
      labelColor: DEFAULT_LABEL_COLOR,
      labelSide: column < maxColumn / 2 ? 'right' : 'left',
      labelAlign: column < maxColumn / 2 ? 'left' : 'right',
    }
    const columnNodes = nodesByColumn.get(column) || []
    columnNodes.push(node)
    nodesByColumn.set(column, columnNodes)
  })

  const scaleCandidates: number[] = []
  for (const columnNodes of nodesByColumn.values()) {
    const columnValue = columnNodes.reduce((sum, node) => sum + node.value, 0)
    const available = drawableHeight - Math.max(0, columnNodes.length - 1) * nodePadding
    if (columnValue > 0 && available > 0) {
      scaleCandidates.push(available / columnValue)
    }
  }
  const valueScale = Math.max(1, Math.min(...scaleCandidates))

  for (const [column, columnNodes] of nodesByColumn.entries()) {
    columnNodes.sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
    const usedHeight = columnNodes.reduce((sum, node) => sum + node.value * valueScale, 0)
      + Math.max(0, columnNodes.length - 1) * nodePadding
    let cursor = topInset + Math.max(0, (drawableHeight - usedHeight) / 2)

    for (const node of columnNodes) {
      const nodeHeight = Math.max(10, node.value * valueScale)
      node.y0 = cursor
      node.y1 = cursor + nodeHeight
      node.labelSide = column < maxColumn / 2 ? 'right' : 'left'
      node.labelAlign = column < maxColumn / 2 ? 'left' : 'right'
      cursor = node.y1 + nodePadding
    }
  }

  const nodeMap = new Map(nodeIds.map((id) => [id, nodesByColumn.get(columns.get(id) || 0)!.find((node) => node.id === id)!]))
  const sourceOffsets = new Map<string, number>()
  const targetOffsets = new Map<string, number>()

  const links: SankeyLink[] = rawLinks
    .slice()
    .sort((left, right) => {
      const leftSource = nodeMap.get(left.source)!
      const rightSource = nodeMap.get(right.source)!
      if (leftSource.y0 !== rightSource.y0) return leftSource.y0 - rightSource.y0
      const leftTarget = nodeMap.get(left.target)!
      const rightTarget = nodeMap.get(right.target)!
      return leftTarget.y0 - rightTarget.y0
    })
    .map((link) => {
      const sourceNode = nodeMap.get(link.source)!
      const targetNode = nodeMap.get(link.target)!
      const linkWidth = Math.max(1, link.value * valueScale)
      const sourceOffset = sourceOffsets.get(link.source) || 0
      const targetOffset = targetOffsets.get(link.target) || 0
      const sourceY = sourceNode.y0 + sourceOffset + linkWidth / 2
      const targetY = targetNode.y0 + targetOffset + linkWidth / 2
      sourceOffsets.set(link.source, sourceOffset + linkWidth)
      targetOffsets.set(link.target, targetOffset + linkWidth)
      return {
        source: link.source,
        target: link.target,
        value: link.value,
        sourceLabel: sourceNode.label,
        targetLabel: targetNode.label,
        path: pathBetween(sourceNode.x1, sourceY, targetNode.x0, targetY),
        width: linkWidth,
        stroke: sourceNode.fill,
      }
    })

  return {
    $schema: VEGA_SCHEMA,
    ...(title ? {
      title: {
        text: title,
        anchor: 'start',
        color: DEFAULT_LABEL_COLOR,
        fontSize: 15,
        fontWeight: 600,
        offset: 10,
      },
    } : {}),
    width,
    height,
    padding: 0,
    background: 'transparent',
    data: [
      {
        name: 'nodes',
        values: Array.from(nodeMap.values()).map((node) => ({
          ...node,
          midY: (node.y0 + node.y1) / 2,
        })),
      },
      {
        name: 'links',
        values: links,
      },
    ],
    marks: [
      {
        type: 'path',
        from: { data: 'links' },
        encode: {
          update: {
            path: { field: 'path' },
            stroke: { field: 'stroke' },
            strokeOpacity: { value: 0.35 },
            strokeWidth: { field: 'width' },
            fill: { value: null },
            strokeCap: { value: 'round' },
            tooltip: {
              signal: "datum.sourceLabel + ' → ' + datum.targetLabel + ': ' + format(datum.value, ',.2f')",
            },
          },
        },
      },
      {
        type: 'rect',
        from: { data: 'nodes' },
        encode: {
          update: {
            x: { field: 'x0' },
            x2: { field: 'x1' },
            y: { field: 'y0' },
            y2: { field: 'y1' },
            fill: { field: 'fill' },
            fillOpacity: { value: 0.9 },
            stroke: { value: 'rgba(35,31,51,0.18)' },
            cornerRadius: { value: 2 },
            tooltip: { signal: "datum.label + ': ' + format(datum.value, ',.2f')" },
          },
        },
      },
      {
        type: 'text',
        from: { data: 'nodes' },
        encode: {
          update: {
            x: { signal: "datum.labelSide === 'right' ? datum.x1 + 8 : datum.x0 - 8" },
            y: { field: 'midY' },
            align: { field: 'labelAlign' },
            baseline: { value: 'middle' },
            text: { field: 'label' },
            fill: { field: 'labelColor' },
            fontSize: { value: 11 },
            fontWeight: { value: 500 },
            limit: { signal: "datum.labelSide === 'right' ? width - datum.x1 - 12 : datum.x0 - 12" },
          },
        },
      },
    ],
  }
}

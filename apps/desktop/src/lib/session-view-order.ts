const DEFAULT_SESSION_VIEW_NOW_MS = 0
const DEFAULT_SESSION_VIEW_NOW_ISO = '1970-01-01T00:00:00.000Z'

export type SessionViewTiming = {
  nowMs?: number
  nowIso?: string
  formatTimestamp?: (timestamp: number) => string
  order?: number
  segmentOrder?: number
}

type OrderedValue = {
  order?: number | null
}

export function finiteOrder(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function nextOrderFrom(...groups: readonly (readonly OrderedValue[] | OrderedValue | null | undefined)[]) {
  let max = 0
  for (const group of groups) {
    if (!group) continue
    if (Array.isArray(group)) {
      for (const entry of group as readonly OrderedValue[]) {
        const order = finiteOrder(entry.order)
        if (order !== null && order > max) max = order
      }
      continue
    }
    const order = finiteOrder((group as OrderedValue).order)
    if (order !== null && order > max) max = order
  }
  return max + 1
}

export function orderAfterSplitBoundary(fallbackOrder: number, splitAfterOrder?: number) {
  const boundaryOrder = finiteOrder(splitAfterOrder)
  return boundaryOrder === null ? fallbackOrder : Math.max(fallbackOrder, boundaryOrder + 1)
}

export function nowMsFromTiming(timing?: SessionViewTiming) {
  return finiteOrder(timing?.nowMs) ?? DEFAULT_SESSION_VIEW_NOW_MS
}

export function nowIsoFromTiming(timing?: SessionViewTiming) {
  return timing?.nowIso || DEFAULT_SESSION_VIEW_NOW_ISO
}

export function timestampIsoFromTiming(timestamp: number, timing?: SessionViewTiming) {
  return timing?.formatTimestamp?.(timestamp) || nowIsoFromTiming(timing)
}

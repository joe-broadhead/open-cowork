export type SessionViewSequence = {
  nextSeq(): number
  observeSeq(value: number | null | undefined): void
  nowMs(): number
  nowIso(): string
}

export function createSessionViewSequence(options: {
  nowMs?: () => number
  nowIso?: () => string
  initialSeq?: number
} = {}): SessionViewSequence {
  let seq = options.initialSeq ?? 0
  return {
    nextSeq() {
      seq += 1
      return seq
    },
    observeSeq(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return
      seq = Math.max(seq, value)
    },
    nowMs: options.nowMs || (() => Date.now()),
    nowIso: options.nowIso || (() => new Date().toISOString()),
  }
}

let seq = 0

export function nextSeq() {
  return ++seq
}

export function observeSeq(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return
  seq = Math.max(seq, value)
}

export function nowTs() {
  return Date.now()
}

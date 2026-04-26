import { useEffect, useState } from 'react'
import { formatElapsedMs, parseIsoToMs } from './elapsed-clock-utils'

const SECOND_MS = 1_000

type Props = {
  startedAt: string | null | undefined
  finishedAt?: string | null | undefined
  className?: string
  labelWhileRunning?: string
  labelWhileFinished?: string
}

export function ElapsedClock({
  startedAt,
  finishedAt,
  className,
  labelWhileRunning,
  labelWhileFinished,
}: Props) {
  const startedMs = parseIsoToMs(startedAt)
  const finishedMs = parseIsoToMs(finishedAt)
  const isRunning = startedMs != null && finishedMs == null

  // Re-render every second while running. We only need the current timestamp
  // to recompute elapsed; a single tick counter keeps the hook body cheap.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!isRunning) return
    const interval = setInterval(() => setTick((value) => value + 1), SECOND_MS)
    return () => clearInterval(interval)
  }, [isRunning])

  if (startedMs == null) return null

  const endMs = finishedMs ?? Date.now()
  const elapsed = formatElapsedMs(Math.max(0, endMs - startedMs))
  const label = finishedMs != null
    ? (labelWhileFinished ?? `ran ${elapsed}`)
    : (labelWhileRunning ?? elapsed)

  return (
    <span
      className={className}
      title={finishedMs != null ? 'Task duration' : 'Elapsed since the task started running'}
    >
      {label}
    </span>
  )
}

import { useEffect, useState } from 'react'

const SECOND_MS = 1_000

export function useLiveNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) {
      setNow(Date.now())
      return
    }

    setNow(Date.now())
    const interval = window.setInterval(() => {
      setNow(Date.now())
    }, SECOND_MS)
    return () => window.clearInterval(interval)
  }, [active])

  return now
}

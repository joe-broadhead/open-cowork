import { useCallback, useEffect, useRef, useState } from 'react'

export type AdminResourceState<T> = {
  data: T | null
  loading: boolean
  error: string | null
  reload: () => void
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return 'Something went wrong. Try again.'
}

// Loads an async admin resource with first-class loading/error/reload states so
// every section ships the same designed empty/loading/error surfaces. A stale
// response from a superseded load is discarded (generation guard).
export function useAdminResource<T>(loader: () => Promise<T>, deps: readonly unknown[] = []): AdminResourceState<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const generationRef = useRef(0)
  // Keep the latest loader without retriggering the effect on every render.
  const loaderRef = useRef(loader)
  loaderRef.current = loader

  useEffect(() => {
    const generation = generationRef.current + 1
    generationRef.current = generation
    setLoading(true)
    setError(null)
    loaderRef.current()
      .then((result) => {
        if (generationRef.current !== generation) return
        setData(result)
        setLoading(false)
      })
      .catch((err) => {
        if (generationRef.current !== generation) return
        setError(describeError(err))
        setLoading(false)
      })
    // Intentionally keyed on `nonce` + caller deps; the loader is read from a ref.
  }, [nonce, ...deps])

  const reload = useCallback(() => setNonce((value) => value + 1), [])

  return { data, loading, error, reload }
}

import { useEffect, useState } from 'react'

const KNOWLEDGE_COMPACT_QUERY = '(max-width: 920px)'
const KNOWLEDGE_BALANCED_QUERY = '(max-width: 1279px)'

export type KnowledgeLayoutMode = 'compact' | 'balanced' | 'wide'

function currentKnowledgeLayoutMode(): KnowledgeLayoutMode {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'wide'
  if (window.matchMedia(KNOWLEDGE_COMPACT_QUERY).matches) return 'compact'
  if (window.matchMedia(KNOWLEDGE_BALANCED_QUERY).matches) return 'balanced'
  return 'wide'
}

export function useKnowledgeLayoutMode() {
  const [mode, setMode] = useState<KnowledgeLayoutMode>(currentKnowledgeLayoutMode)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const compact = window.matchMedia(KNOWLEDGE_COMPACT_QUERY)
    const balanced = window.matchMedia(KNOWLEDGE_BALANCED_QUERY)
    const update = () => setMode(compact.matches ? 'compact' : balanced.matches ? 'balanced' : 'wide')

    update()
    compact.addEventListener('change', update)
    balanced.addEventListener('change', update)
    return () => {
      compact.removeEventListener('change', update)
      balanced.removeEventListener('change', update)
    }
  }, [])

  return mode
}

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  clampTaskDrillInWidth,
  DEFAULT_TASK_DRILL_IN_WIDTH,
  resolveTaskDrillInWidth,
} from './task-drill-in-layout'

const TASK_DRILL_IN_LAYOUT_STORAGE_KEY = 'open-cowork.task-drill-in.layout.v1'

function readStoredLayoutPreference(): { customWidth: number } | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(TASK_DRILL_IN_LAYOUT_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { customWidth?: number }
    const customWidth = typeof parsed.customWidth === 'number' && Number.isFinite(parsed.customWidth)
      ? parsed.customWidth
      : DEFAULT_TASK_DRILL_IN_WIDTH
    return { customWidth }
  } catch {
    return null
  }
}

export function useTaskDrillInLayout() {
  const storedLayout = useMemo(() => readStoredLayoutPreference(), [])
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth))
  const [customWidth, setCustomWidth] = useState(storedLayout?.customWidth || DEFAULT_TASK_DRILL_IN_WIDTH)
  const [isResizing, setIsResizing] = useState(false)
  const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    setCustomWidth((current) => clampTaskDrillInWidth(current, viewportWidth))
  }, [viewportWidth])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(TASK_DRILL_IN_LAYOUT_STORAGE_KEY, JSON.stringify({
        customWidth,
      }))
    } catch {
      /* localStorage unavailable — non-fatal */
    }
  }, [customWidth])

  useEffect(() => {
    if (!isResizing) return

    const handlePointerMove = (event: PointerEvent) => {
      const current = resizeStateRef.current
      if (!current) return
      const nextWidth = clampTaskDrillInWidth(
        current.startWidth + (current.startX - event.clientX),
        viewportWidth,
      )
      setCustomWidth(nextWidth)
    }

    const finishResize = () => {
      resizeStateRef.current = null
      setIsResizing(false)
    }

    const previousUserSelect = document.body.style.userSelect
    const previousCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', finishResize)

    return () => {
      document.body.style.userSelect = previousUserSelect
      document.body.style.cursor = previousCursor
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', finishResize)
    }
  }, [isResizing, viewportWidth])

  const drawerWidth = useMemo(() => resolveTaskDrillInWidth({
    customWidth,
    viewportWidth,
  }), [customWidth, viewportWidth])

  const onStartResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    resizeStateRef.current = {
      startX: event.clientX,
      startWidth: drawerWidth,
    }
    setCustomWidth(drawerWidth)
    setIsResizing(true)
    event.preventDefault()
  }, [drawerWidth])

  return {
    drawerWidth,
    isResizing,
    onStartResize,
  }
}

import { useCallback, useEffect, useState } from 'react'
import { useAppApi } from '@open-cowork/ui/app-api'
import type { AppApiEventPayload } from '@open-cowork/shared'
import { projectionSequence } from './react-workbench-controller.ts'

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error || 'Request failed')
}

function sessionsFromResponse(response: unknown): unknown[] {
  return Array.isArray((response as { sessions?: unknown[] })?.sessions) ? (response as { sessions: unknown[] }).sessions : []
}

export function useCloudSessions(query: Record<string, string | number | boolean | null | undefined> = {}) {
  const api = useAppApi()
  const queryKey = JSON.stringify(query)
  const [sessions, setSessions] = useState<unknown[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const reload = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      setSessions(sessionsFromResponse(await api.sessions.list(JSON.parse(queryKey) as Record<string, string | number | boolean | null | undefined>)))
    } catch (nextError) {
      setError(message(nextError))
    } finally {
      setIsLoading(false)
    }
  }, [api, queryKey])

  useEffect(() => {
    void reload()
  }, [reload])

  return { sessions, error, isLoading, reload }
}

export function useCloudSessionView(sessionId: string | null | undefined) {
  const api = useAppApi()
  const [view, setView] = useState<unknown | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const reload = useCallback(async () => {
    if (!sessionId) {
      setView(null)
      return
    }
    setIsLoading(true)
    setError(null)
    try {
      setView(await api.sessions.view(sessionId))
    } catch (nextError) {
      setError(message(nextError))
    } finally {
      setIsLoading(false)
    }
  }, [api, sessionId])

  useEffect(() => {
    if (!sessionId) {
      setView(null)
      return undefined
    }
    let closed = false
    let stream: { close: () => void } | null = null
    setIsLoading(true)
    setError(null)
    void (async () => {
      try {
        const nextView = await api.sessions.view(sessionId)
        if (closed) return
        setView(nextView)
        stream = api.sessions.events(sessionId, { message: () => void reload() }, { afterSequence: projectionSequence(nextView) })
      } catch (nextError) {
        if (!closed) setError(message(nextError))
      } finally {
        if (!closed) setIsLoading(false)
      }
    })()
    return () => {
      closed = true
      stream?.close()
    }
  }, [api, reload, sessionId])

  return { view, error, isLoading, reload }
}

export function useCloudWorkspaceEvents(onEvent: (event: AppApiEventPayload) => void) {
  const api = useAppApi()
  useEffect(() => {
    const stream = api.workspace.events({ message: onEvent })
    return () => stream.close()
  }, [api, onEvent])
}

export function useCloudComposer() {
  const api = useAppApi()
  const [isSending, setIsSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = useCallback(async (input: {
    sessionId?: string | null
    text: string
    agent?: string | null
    create?: unknown
  }) => {
    const text = input.text.trim()
    if (!text) return null
    setIsSending(true)
    setError(null)
    try {
      const session = input.sessionId ? null : await api.sessions.create(input.create || {})
      const sessionId = input.sessionId || String((session as { session?: { sessionId?: string }; sessionId?: string })?.session?.sessionId || (session as { sessionId?: string })?.sessionId || '')
      if (!sessionId) throw new Error('Cloud session was not created')
      await api.sessions.prompt(sessionId, { text, agent: input.agent || undefined })
      return sessionId
    } catch (nextError) {
      setError(message(nextError))
      return null
    } finally {
      setIsSending(false)
    }
  }, [api])

  return { send, isSending, error }
}

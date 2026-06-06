import { useEffect, type Dispatch, type SetStateAction } from 'react'
import type { AppAPI } from '@open-cowork/shared'
import type { CloudWebClientBootstrap } from './client-contract.ts'
import { assertCloudProjectSourceAllowed, cloudProjectSourceFromForm } from './react-project-source.ts'
import {
  asRecord,
  errorMessage,
  sessionIdFromCreateResult,
  sessionViewFromCreateResult,
  setCloudStatus,
  setRouteHash,
} from './react-workbench-controller.ts'
import type { CloudWebThreadView } from './thread-workbench.ts'

type UseCloudWorkbenchFormsInput = {
  api: AppAPI
  bootstrap: CloudWebClientBootstrap
  workspace: unknown
  composerTarget: HTMLElement | null
  sessionFormTarget: HTMLElement | null
  composerText: string
  composerAgent: string
  isSending: boolean
  selectedSessionId: string | null
  setComposerText: Dispatch<SetStateAction<string>>
  setIsSending: Dispatch<SetStateAction<boolean>>
  setError: Dispatch<SetStateAction<string | null>>
  setViews: Dispatch<SetStateAction<Record<string, CloudWebThreadView | undefined>>>
  setSelectedSessionId: Dispatch<SetStateAction<string | null>>
  loadSessions: (options?: { keepSelection?: boolean, preserveLoadedPages?: boolean }) => Promise<void>
  loadView: (sessionId: string) => Promise<CloudWebThreadView>
}

export function useCloudWorkbenchForms(input: UseCloudWorkbenchFormsInput) {
  const {
    api,
    bootstrap,
    workspace,
    composerTarget,
    sessionFormTarget,
    composerText,
    composerAgent,
    isSending,
    selectedSessionId,
    setComposerText,
    setIsSending,
    setError,
    setViews,
    setSelectedSessionId,
    loadSessions,
    loadView,
  } = input

  useEffect(() => {
    if (!composerTarget) return undefined
    composerTarget.dataset.reactOwned = 'chat'
    const handler = (event: SubmitEvent) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      void (async () => {
        const formData = new FormData(composerTarget as HTMLFormElement)
        const text = String(formData.get('text') || composerText).trim()
        const agent = String(formData.get('agent') || composerAgent).trim()
        if (!text || isSending) return
        setIsSending(true)
        setError(null)
        try {
          let sessionId = selectedSessionId
          if (!sessionId) {
            const created = await api.sessions.create({ profileName: bootstrap.profileName, projectSource: null })
            sessionId = sessionIdFromCreateResult(created)
            if (!sessionId) throw new Error('Cloud session was not created')
            setViews((current) => ({ ...current, [sessionId as string]: sessionViewFromCreateResult(created) }))
            setSelectedSessionId(sessionId)
          }
          const prompted = asRecord(await api.sessions.prompt(sessionId, { text, agent: agent || undefined }))
          if (prompted.view) setViews((current) => ({ ...current, [sessionId as string]: prompted.view as CloudWebThreadView }))
          setComposerText('')
          await loadSessions({ keepSelection: true, preserveLoadedPages: true })
          await loadView(sessionId)
          setRouteHash('chat')
          setCloudStatus('Ready', 'ok')
        } catch (nextError) {
          const message = errorMessage(nextError)
          setError(message)
          setCloudStatus(message, 'warn')
        } finally {
          setIsSending(false)
        }
      })()
    }
    composerTarget.addEventListener('submit', handler, true)
    return () => composerTarget.removeEventListener('submit', handler, true)
  }, [api, bootstrap.profileName, composerAgent, composerTarget, composerText, isSending, loadSessions, loadView, selectedSessionId, setComposerText, setError, setIsSending, setSelectedSessionId, setViews])

  useEffect(() => {
    if (!sessionFormTarget) return undefined
    sessionFormTarget.dataset.reactOwned = 'project-session'
    const handler = (event: SubmitEvent) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      void (async () => {
        const form = sessionFormTarget as HTMLFormElement
        const formData = new FormData(form)
        setError(null)
        setIsSending(true)
        try {
          const projectSource = await cloudProjectSourceFromForm(api, form, formData)
          await assertCloudProjectSourceAllowed(api, projectSource)
          const created = await api.sessions.create({
            profileName: String(formData.get('profileName') || asRecord(workspace).profileName || bootstrap.profileName || 'default').trim(),
            projectSource,
          })
          const sessionId = sessionIdFromCreateResult(created)
          if (sessionId) {
            setViews((current) => ({ ...current, [sessionId]: sessionViewFromCreateResult(created) }))
            setSelectedSessionId(sessionId)
            await loadSessions({ keepSelection: true, preserveLoadedPages: true })
            await loadView(sessionId)
            setRouteHash('chat')
            setCloudStatus('Chat started', 'ok')
          } else {
            await loadSessions({ keepSelection: true, preserveLoadedPages: true })
            setCloudStatus('Chat created', 'ok')
          }
        } catch (nextError) {
          const message = errorMessage(nextError)
          setError(message)
          setCloudStatus(message, 'warn')
        } finally {
          setIsSending(false)
        }
      })()
    }
    sessionFormTarget.addEventListener('submit', handler, true)
    return () => sessionFormTarget.removeEventListener('submit', handler, true)
  }, [api, bootstrap.profileName, loadSessions, loadView, sessionFormTarget, setError, setIsSending, setSelectedSessionId, setViews, workspace])
}

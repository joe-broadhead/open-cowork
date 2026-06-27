import { useCallback, useEffect, type Dispatch, type SetStateAction } from 'react'
import type { AppAPI } from '@open-cowork/shared'
import type { CloudWebClientBootstrap } from './client-contract.ts'
import { assertCloudProjectSourceAllowed, cloudProjectSourceFromForm } from './react-project-source.ts'
import { cloudWebPromptAssignment } from './surface-workbench.ts'
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
  allowedAgents: string[]
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
    allowedAgents,
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

  // The single cloud new-chat/submit path: create the session if needed, then
  // prompt it. Shared verbatim between the chat `#prompt-form` submit handler and
  // the launchpad Home composer so both flows hit the same api.sessions.create +
  // api.sessions.prompt sequence (no duplicate/invented endpoint).
  const submitComposerPrompt = useCallback(async (rawText: string, rawAgent: string) => {
    const text = rawText.trim()
    const agent = rawAgent.trim()
    if (!text || isSending) return
    const assignment = cloudWebPromptAssignment(text, allowedAgents, agent)
    if (!assignment.text) {
      setError('Add a message after the coworker mention.')
      setCloudStatus('Add a message after the coworker mention.', 'warn')
      return
    }
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
      const prompted = asRecord(await api.sessions.prompt(sessionId, { text: assignment.text, agent: assignment.agent || undefined }))
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
  }, [allowedAgents, api, bootstrap.profileName, isSending, loadSessions, loadView, selectedSessionId, setComposerText, setError, setIsSending, setSelectedSessionId, setViews])

  useEffect(() => {
    if (!composerTarget) return undefined
    composerTarget.dataset.reactOwned = 'chat'
    const handler = (event: SubmitEvent) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      const formData = new FormData(composerTarget as HTMLFormElement)
      const text = String(formData.get('text') || composerText)
      const agent = String(formData.get('agent') || composerAgent)
      void submitComposerPrompt(text, agent)
    }
    composerTarget.addEventListener('submit', handler, true)
    return () => composerTarget.removeEventListener('submit', handler, true)
  }, [composerAgent, composerTarget, composerText, submitComposerPrompt])

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

  // Abort the in-flight turn for the selected chat (mirrors desktop's Stop/Esc).
  // Refreshes the view + list so the stopped turn is reflected immediately.
  const stopGenerating = useCallback(() => {
    if (!selectedSessionId) return
    void (async () => {
      setError(null)
      try {
        await api.sessions.abort(selectedSessionId)
        await loadView(selectedSessionId)
        await loadSessions({ keepSelection: true, preserveLoadedPages: true })
        setCloudStatus('Stopped', 'ok')
      } catch (nextError) {
        const message = errorMessage(nextError)
        setError(message)
        setCloudStatus(message, 'warn')
      }
    })()
  }, [api, loadSessions, loadView, selectedSessionId, setError])

  return { stopGenerating, submitComposerPrompt }
}

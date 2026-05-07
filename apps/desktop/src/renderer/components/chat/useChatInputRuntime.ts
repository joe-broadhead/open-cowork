import { type Dispatch, type RefObject, type SetStateAction, useEffect, useState } from 'react'
import type { Attachment, InlinePickerState, MentionableAgent } from './chat-input-types'
import { formatAgentLabel } from './chat-input-utils'
import { COMPOSER_COMPOSE_EVENT, COMPOSER_INSERT_EVENT, type ComposerComposeDetail } from './composer-events'

type ModelCatalog = Record<string, Array<{ id: string; label: string; featured?: boolean }>>

type ResizeComposerTextarea = (element?: HTMLTextAreaElement | null) => void

export function useChatRuntimeSelection() {
  const [currentModel, setCurrentModel] = useState('')
  const [provider, setProvider] = useState('')
  const [availableModels, setAvailableModels] = useState<ModelCatalog>({})

  useEffect(() => {
    let disposed = false
    const refreshRuntimeSelection = () => {
      Promise.all([window.coworkApi.settings.get(), window.coworkApi.app.config()]).then(([settings, config]) => {
        if (disposed) return
        setCurrentModel(settings.effectiveModel || settings.selectedModelId || '')
        setProvider(settings.effectiveProviderId || '')
        setAvailableModels(Object.fromEntries(
          config.providers.available.map((entry) => [
            entry.id,
            entry.models.map((model) => ({ id: model.id, label: model.name, featured: model.featured })),
          ]),
        ))
      }).catch((err) => {
        if (!disposed) console.error('Failed to load chat settings:', err)
      })
    }

    refreshRuntimeSelection()
    const unsubscribe = window.coworkApi.on.runtimeReady(() => refreshRuntimeSelection())
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  return {
    currentModel,
    setCurrentModel,
    provider,
    availableModels,
  }
}

export function useMentionableAgents(currentProjectDirectory: string | null) {
  const [specialistAgents, setSpecialistAgents] = useState<MentionableAgent[]>([])

  useEffect(() => {
    let disposed = false
    const loadRuntimeCatalog = () => {
      Promise.all([
        window.coworkApi.app.builtinAgents(),
        window.coworkApi.agents.list(currentProjectDirectory ? { directory: currentProjectDirectory } : undefined),
      ]).then(([builtins, customAgents]) => {
        if (disposed) return
        const builtinAgents = (builtins || [])
          .filter((agent) => agent.mode === 'subagent' && !agent.hidden && agent.surface !== 'automation')
          .map((agent) => ({
            id: agent.name,
            label: agent.label || formatAgentLabel(agent.name),
            description: agent.description || 'Focused delegated work',
          }))
        const userAgents = (customAgents || [])
          .filter((agent) => agent.enabled && agent.valid)
          .map((agent) => ({
            id: agent.name,
            label: formatAgentLabel(agent.name),
            description: agent.description || 'Focused delegated work',
          }))

        setSpecialistAgents(
          [...builtinAgents, ...userAgents].sort((a, b) => a.label.localeCompare(b.label)),
        )
      }).catch(() => {
        if (!disposed) setSpecialistAgents([])
      })
    }

    loadRuntimeCatalog()
    const unsubscribe = window.coworkApi.on.runtimeReady(() => loadRuntimeCatalog())
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [currentProjectDirectory])

  return specialistAgents
}

export function useComposerExternalEvents({
  textareaRef,
  resizeComposerTextarea,
  setInput,
  setAttachments,
  setInlinePicker,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  resizeComposerTextarea: ResizeComposerTextarea
  setInput: Dispatch<SetStateAction<string>>
  setAttachments: Dispatch<SetStateAction<Attachment[]>>
  setInlinePicker: Dispatch<SetStateAction<InlinePickerState | null>>
}) {
  useEffect(() => {
    const focusComposer = (cursor?: number) => {
      requestAnimationFrame(() => {
        const element = textareaRef.current
        if (!element) return
        element.focus()
        if (typeof cursor === 'number') {
          element.setSelectionRange(cursor, cursor)
        }
        resizeComposerTextarea(element)
      })
    }

    const insertHandler = (event: Event) => {
      const customEvent = event as CustomEvent<{ text?: string }>
      const insertedText = customEvent.detail?.text
      if (typeof insertedText !== 'string' || !insertedText.trim()) return

      setInlinePicker(null)
      setInput((current) => {
        const textarea = textareaRef.current
        const start = textarea?.selectionStart ?? current.length
        const end = textarea?.selectionEnd ?? current.length
        const next = `${current.slice(0, start)}${insertedText}${current.slice(end)}`
        const cursor = start + insertedText.length
        focusComposer(cursor)
        return next
      })
    }

    const composeHandler = (event: Event) => {
      const customEvent = event as CustomEvent<ComposerComposeDetail>
      const nextText = typeof customEvent.detail?.text === 'string' ? customEvent.detail.text : ''
      const nextAttachments = Array.isArray(customEvent.detail?.attachments)
        ? customEvent.detail.attachments.filter((attachment): attachment is Attachment =>
          Boolean(attachment)
          && typeof attachment.mime === 'string'
          && typeof attachment.url === 'string'
          && typeof attachment.filename === 'string')
        : []
      const replaceText = customEvent.detail?.replaceText === true

      if (!nextText.trim() && nextAttachments.length === 0) return

      setInlinePicker(null)
      if (nextAttachments.length > 0) {
        setAttachments((current) => [...current, ...nextAttachments])
      }

      if (nextText.trim()) {
        setInput((current) => {
          const textarea = textareaRef.current
          const start = replaceText ? 0 : (textarea?.selectionStart ?? current.length)
          const end = replaceText ? current.length : (textarea?.selectionEnd ?? current.length)
          const next = `${current.slice(0, start)}${nextText}${current.slice(end)}`
          focusComposer(start + nextText.length)
          return next
        })
      } else {
        focusComposer()
      }
    }

    window.addEventListener(COMPOSER_INSERT_EVENT, insertHandler as EventListener)
    window.addEventListener(COMPOSER_COMPOSE_EVENT, composeHandler as EventListener)
    return () => {
      window.removeEventListener(COMPOSER_INSERT_EVENT, insertHandler as EventListener)
      window.removeEventListener(COMPOSER_COMPOSE_EVENT, composeHandler as EventListener)
    }
  }, [resizeComposerTextarea, setAttachments, setInlinePicker, setInput, textareaRef])
}

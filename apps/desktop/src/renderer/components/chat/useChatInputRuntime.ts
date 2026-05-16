import { type Dispatch, type RefObject, type SetStateAction, useEffect, useMemo, useState } from 'react'
import { t } from '../../helpers/i18n'
import { useSessionStore } from '../../stores/session'
import type { Attachment, ChatInputModelEntry, InlinePickerState, MentionableAgent } from './chat-input-types'
import { formatAgentLabel } from '../../helpers/agent-label.ts'
import { ensureAttachmentId } from './chat-input-utils.ts'
import { COMPOSER_COMPOSE_EVENT, COMPOSER_INSERT_EVENT, type ComposerComposeDetail } from './composer-events'

type ModelCatalog = Record<string, ChatInputModelEntry[]>

type ResizeComposerTextarea = (element?: HTMLTextAreaElement | null) => void

function describeChatSettingsError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function reportChatSettingsError(error: unknown) {
  try {
    window.coworkApi?.diagnostics?.reportRendererError?.({
      message: `Failed to load chat settings: ${describeChatSettingsError(error)}`,
      stack: error instanceof Error ? error.stack : undefined,
      view: 'chat',
    })
  } catch {
    // Diagnostics are best-effort from a composer recovery path.
  }
}

export function useChatRuntimeSelection() {
  const [currentModel, setCurrentModel] = useState('')
  const [provider, setProvider] = useState('')
  const [availableModels, setAvailableModels] = useState<ModelCatalog>({})
  const addGlobalError = useSessionStore((s) => s.addGlobalError)

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
            entry.models.map((model) => ({
              id: model.id,
              label: model.name,
              featured: model.featured,
              reasoning: model.reasoning,
              variants: model.variants,
            })),
          ]),
        ))
      }).catch((err) => {
        if (disposed) return
        addGlobalError(t('chat.settingsLoadFailed', 'Could not load chat settings. The composer may show stale model options.'))
        reportChatSettingsError(err)
      })
    }

    refreshRuntimeSelection()
    const unsubscribe = window.coworkApi.on.runtimeReady(() => refreshRuntimeSelection())
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [addGlobalError])

  return {
    currentModel,
    setCurrentModel,
    provider,
    availableModels,
  }
}

export function useReasoningVariantSelection(provider: string, currentModel: string, availableModels: ModelCatalog) {
  const reasoningVariant = useSessionStore((s) => s.reasoningVariant)
  const setReasoningVariant = useSessionStore((s) => s.setReasoningVariant)
  const currentModelEntry = useMemo(
    () => (availableModels[provider] || []).find((model) => model.id === currentModel) || null,
    [availableModels, currentModel, provider],
  )
  const reasoningVariants = useMemo(
    () => Array.from(new Set(currentModelEntry?.variants || [])).filter(Boolean),
    [currentModelEntry],
  )
  const activeReasoningVariant = reasoningVariant && reasoningVariants.includes(reasoningVariant)
    ? reasoningVariant
    : null
  const supportsReasoning = reasoningVariants.length > 0
  const promptOptions = useMemo(
    () => activeReasoningVariant ? { variant: activeReasoningVariant } : undefined,
    [activeReasoningVariant],
  )

  useEffect(() => {
    if (reasoningVariant && !reasoningVariants.includes(reasoningVariant)) {
      setReasoningVariant(null)
    }
  }, [reasoningVariant, reasoningVariants, setReasoningVariant])

  return {
    supportsReasoning,
    reasoningVariants,
    reasoningVariant: activeReasoningVariant,
    setReasoningVariant,
    promptOptions,
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
          .filter((agent) => agent.mode === 'subagent' && !agent.hidden && agent.surface !== 'workflow')
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
          .map((attachment) => ensureAttachmentId(attachment))
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

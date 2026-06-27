import { useCallback, useEffect, useRef, type CSSProperties, type Dispatch, type SetStateAction } from 'react'
import { Icon } from '@open-cowork/ui'
import type { CloudWebClientBootstrap } from './client-contract.ts'
import {
  cloudWebCoworkerInitials,
  type CloudWebCoworkerOption,
  cloudWebCoworkerTone,
  cloudWebPromptAssignment,
} from './surface-workbench.ts'

// Upper bound on the Home composer's auto-grow, matching desktop HomeComposer's
// MAX_COMPOSER_HEIGHT and the cloud chat composer's max-height so the textarea
// never dominates the landing page.
const MAX_COMPOSER_HEIGHT = 220

// The launchpad Home composer — the primary action on the cloud Home, mirroring
// desktop's HomeComposer. It is a second, controlled view of the same shared
// composer state (composerText / composerAgent), so suggestion prefills and the
// chat `#prompt-form` stay in lockstep. Submitting runs the EXACT shared cloud
// new-chat path (api.sessions.create then api.sessions.prompt) via onSubmit, the
// same callback the chat composer's form submit uses — no separate endpoint.
export type CloudLaunchpadComposerProps = {
  bootstrap: CloudWebClientBootstrap
  allowedAgents: string[]
  coworkerOptions: CloudWebCoworkerOption[]
  activeCoworker: string
  composerText: string
  composerAgent: string
  error: string | null
  isSending: boolean
  onSetComposerText: Dispatch<SetStateAction<string>>
  onSetComposerAgent: Dispatch<SetStateAction<string>>
  onSubmit: (text: string, agent: string) => void | Promise<void>
}

export function CloudLaunchpadComposer({
  bootstrap,
  allowedAgents,
  coworkerOptions,
  activeCoworker,
  composerText,
  composerAgent,
  error,
  isSending,
  onSetComposerText,
  onSetComposerAgent,
  onSubmit,
}: CloudLaunchpadComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const chatDisabled = bootstrap.features.chat === false
  const canSend = !isSending && !chatDisabled && cloudWebPromptAssignment(composerText, allowedAgents, composerAgent).text.trim().length > 0
  const activeOption = coworkerOptions.find((option) => option.name === activeCoworker)
  const assignmentSummary = activeOption
    ? `Assigned to ${activeOption.displayName} - ${activeOption.role} - ${activeOption.availability}`
    : activeCoworker ? `Assigned to ${activeCoworker}` : 'Assigned to profile default'

  const autosize = useCallback(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, MAX_COMPOSER_HEIGHT)}px`
  }, [])

  useEffect(() => {
    // Autofocus on mount — the composer is the primary action on Home (matches
    // desktop HomeComposer), so meeting the user with a ready cursor is the point.
    if (!chatDisabled) textareaRef.current?.focus()
  }, [chatDisabled])

  useEffect(() => {
    // Keep the auto-grow in sync when suggestions prefill the shared state.
    autosize()
  }, [autosize, composerText])

  const submit = useCallback(() => {
    if (!canSend) return
    void onSubmit(composerText, composerAgent)
  }, [canSend, composerAgent, composerText, onSubmit])

  return (
    <form
      className="cloud-launchpad-composer"
      aria-label="Home composer"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className="cloud-launchpad-composer__assign-row">
        <span className="cloud-launchpad-composer__assign-label">Assign to</span>
        <label className="composer-select-label cloud-launchpad-composer__assign-pill" data-has-lead={activeCoworker ? 'true' : 'false'} title={assignmentSummary} style={{ '--studio-tone': cloudWebCoworkerTone(activeCoworker || 'default') } as CSSProperties}>
          <span className="studio-coworker-avatar studio-coworker-avatar--sm" aria-hidden="true">
            {cloudWebCoworkerInitials(activeCoworker || 'OC')}
          </span>
          <span className="sr-only">Assign to coworker</span>
          <select
            className="cloud-launchpad-composer__assign-select"
            aria-label="Assign to coworker"
            value={composerAgent}
            disabled={isSending || chatDisabled}
            onChange={(event) => onSetComposerAgent(event.currentTarget.value)}
          >
            <option value="">Default coworker</option>
            {coworkerOptions.map((agent) => <option key={agent.name} value={agent.name}>{agent.displayName} - {agent.role}</option>)}
          </select>
        </label>
      </div>
      <label className="sr-only" htmlFor="cloud-launchpad-composer-input">Ask anything, or @mention a coworker</label>
      <textarea
        id="cloud-launchpad-composer-input"
        ref={textareaRef}
        className="cloud-launchpad-composer__textarea"
        name="text"
        rows={1}
        value={composerText}
        disabled={isSending || chatDisabled}
        placeholder="Ask anything, or @mention a coworker"
        onChange={(event) => {
          onSetComposerText(event.currentTarget.value)
          autosize()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
        }}
      />
      <div className="cloud-launchpad-composer__toolbar" aria-label="Composer controls">
        <div className="cloud-launchpad-composer__toolbar-group">
          <button className="icon-button ghost" type="button" data-managed-control="true" disabled title="Cloud file attachments use project snapshots from Projects" aria-label="Attach file">
            <Icon name="paperclip" size={16} />
          </button>
          <button className="cloud-launchpad-composer__model" type="button" data-managed-control="true" disabled title="Model selection is managed by this cloud workspace">
            <Icon name="sliders" size={16} />
            <span>Cloud model</span>
          </button>
        </div>
        <div className="cloud-launchpad-composer__toolbar-group">
          <span className="pill" data-kind={error ? 'warn' : isSending ? 'warn' : 'ok'}>{error || (chatDisabled ? 'disabled' : isSending ? 'sending' : 'ready')}</span>
          <button className="composer-send" type="submit" disabled={!canSend} aria-label="Send message">
            <span className="sr-only">Send message</span>
            <Icon name="send" size={16} />
          </button>
        </div>
      </div>
    </form>
  )
}

import { useEffect, type Dispatch, type SetStateAction, type CSSProperties } from 'react'
import { Icon } from '@open-cowork/ui'
import type { CloudWebClientBootstrap } from './client-contract.ts'
import {
  cloudWebCoworkerInitials,
  type CloudWebCoworkerOption,
  cloudWebCoworkerTone,
  cloudWebPromptAssignment,
  ensureCloudWebCoworkerMention,
} from './surface-workbench.ts'

type StudioToneStyle = CSSProperties & {
  '--studio-tone'?: string
}

type CloudComposerPortalProps = {
  bootstrap: CloudWebClientBootstrap
  allowedAgents: string[]
  coworkerOptions: CloudWebCoworkerOption[]
  activeCoworker: string
  composerText: string
  composerAgent: string
  error: string | null
  isSending: boolean
  selectedSessionId: string | null
  setComposerText: Dispatch<SetStateAction<string>>
  setComposerAgent: Dispatch<SetStateAction<string>>
  onStopGenerating: () => void
}

export function CloudComposerPortal(props: CloudComposerPortalProps) {
  const {
    bootstrap,
    allowedAgents,
    coworkerOptions,
    activeCoworker,
    composerText,
    composerAgent,
    error,
    isSending,
    selectedSessionId,
    setComposerText,
    setComposerAgent,
    onStopGenerating,
  } = props
  const chatDisabled = bootstrap.features.chat === false
  const canSend = cloudWebPromptAssignment(composerText, allowedAgents, composerAgent).text.trim().length > 0
  const activeOption = coworkerOptions.find((option) => option.name === activeCoworker)
  const avatarStyle: StudioToneStyle = {
    '--studio-tone': cloudWebCoworkerTone(activeCoworker || 'default'),
  }

  // Mirror desktop's Esc-to-abort: while a turn is in flight, Escape stops it.
  // Bound on the composer form (the textarea is disabled while sending, so a
  // listener on it would never fire) and only active during the in-flight turn.
  useEffect(() => {
    if (!isSending) return undefined
    const form = document.getElementById('prompt-form')
    if (!form) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onStopGenerating()
      }
    }
    form.addEventListener('keydown', onKeyDown)
    return () => form.removeEventListener('keydown', onKeyDown)
  }, [isSending, onStopGenerating])

  return (
    <>
      <label className="sr-only" htmlFor="chat-message-input">Message</label>
      <div className="composer-lead-row" data-has-lead={activeCoworker ? 'true' : 'false'}>
        <span
          className="studio-coworker-avatar studio-coworker-avatar--sm"
          style={avatarStyle}
          aria-hidden="true"
        >
          {cloudWebCoworkerInitials(activeCoworker || 'OC')}
        </span>
        <span>
          {activeOption
            ? `Assign to: ${activeOption.displayName} - ${activeOption.role} - ${activeOption.availability}`
            : activeCoworker ? `Assign to: ${activeCoworker}` : 'Assign to: profile default'}
        </span>
      </div>
      <div className="composer-input-chrome">
        <textarea
          id="chat-message-input"
          className="chat-composer-textarea"
          name="text"
          rows={1}
          value={composerText}
          disabled={isSending || chatDisabled}
          placeholder={selectedSessionId ? 'Continue the conversation...' : 'Ask anything, or @mention a coworker'}
          onChange={(event) => setComposerText(event.currentTarget.value)}
        />
      </div>
      <div className="composer-agent-chips" id="composer-agent-chips" aria-label="Coworker shortcuts">
        {coworkerOptions.slice(0, 5).map((agent) => (
          <button
            key={agent.name}
            type="button"
            className="agent-chip"
            data-active={activeCoworker === agent.name ? 'true' : 'false'}
            title={`${agent.role}. ${agent.capabilityHint}`}
            onClick={() => {
              setComposerAgent(agent.name)
              setComposerText((current) => ensureCloudWebCoworkerMention(current, agent.name))
              const select = document.getElementById('composer-agent') as HTMLSelectElement | null
              if (select) select.value = agent.name
            }}
          >
            @{agent.name}
          </button>
        ))}
      </div>
      <div className="composer-toolbar" aria-label="Chat controls">
        <div className="composer-toolbar-group">
          <button className="icon-button ghost" type="button" data-managed-control="true" disabled title="Cloud file attachments use project snapshots from Projects" aria-label="Attach file">
            <Icon name="paperclip" size={16} />
          </button>
          <label className="composer-select-label">
            <span>Assign to</span>
            <select id="composer-agent" name="agent" value={composerAgent} disabled={isSending} onChange={(event) => setComposerAgent(event.currentTarget.value)}>
              <option value="">Default coworker</option>
              {coworkerOptions.map((agent) => <option key={agent.name} value={agent.name}>{agent.displayName} - {agent.role}</option>)}
            </select>
          </label>
        </div>
        <div className="composer-toolbar-group">
          <span className="pill" data-kind={error ? 'warn' : isSending ? 'warn' : 'ok'}>{error || (chatDisabled ? 'disabled' : isSending ? 'sending' : 'ready')}</span>
          {isSending ? (
            <button className="composer-stop" type="button" onClick={onStopGenerating} title="Stop generating (Esc)" aria-label="Stop generating">
              <span className="sr-only">Stop generating</span>
              <Icon name="square" size={16} />
            </button>
          ) : (
            <button className="composer-send" type="submit" disabled={!canSend || chatDisabled} aria-label="Send message">
              <span className="sr-only">Send message</span>
              <Icon name="send" size={16} />
            </button>
          )}
        </div>
      </div>
    </>
  )
}

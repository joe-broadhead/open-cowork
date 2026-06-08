import type { Dispatch, SetStateAction, CSSProperties } from 'react'
import type { CloudWebClientBootstrap } from './client-contract.ts'
import {
  cloudWebCoworkerInitials,
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
  activeCoworker: string
  composerText: string
  composerAgent: string
  error: string | null
  isSending: boolean
  selectedSessionId: string | null
  setComposerText: Dispatch<SetStateAction<string>>
  setComposerAgent: Dispatch<SetStateAction<string>>
}

export function CloudComposerPortal(props: CloudComposerPortalProps) {
  const {
    bootstrap,
    allowedAgents,
    activeCoworker,
    composerText,
    composerAgent,
    error,
    isSending,
    selectedSessionId,
    setComposerText,
    setComposerAgent,
  } = props
  const chatDisabled = bootstrap.features.chat === false
  const canSend = cloudWebPromptAssignment(composerText, allowedAgents, composerAgent).text.trim().length > 0
  const avatarStyle: StudioToneStyle = {
    '--studio-tone': cloudWebCoworkerTone(activeCoworker || 'default'),
  }

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
        <span>{activeCoworker ? `Lead coworker: ${activeCoworker}` : 'Lead coworker: profile default'}</span>
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
        {allowedAgents.slice(0, 5).map((agent) => (
          <button
            key={agent}
            type="button"
            className="agent-chip"
            data-active={activeCoworker === agent ? 'true' : 'false'}
            onClick={() => {
              setComposerAgent(agent)
              setComposerText((current) => ensureCloudWebCoworkerMention(current, agent))
              const select = document.getElementById('composer-agent') as HTMLSelectElement | null
              if (select) select.value = agent
            }}
          >
            @{agent}
          </button>
        ))}
      </div>
      <div className="composer-toolbar" aria-label="Chat controls">
        <div className="composer-toolbar-group">
          <button className="icon-button ghost" type="button" data-managed-control="true" disabled title="Cloud file attachments use project snapshots from Projects" aria-label="Attach file" />
          <label className="composer-select-label">
            <span className="sr-only">Coworker</span>
            <select id="composer-agent" name="agent" value={composerAgent} disabled={isSending} onChange={(event) => setComposerAgent(event.currentTarget.value)}>
              <option value="">Default coworker</option>
              {allowedAgents.map((agent) => <option key={agent} value={agent}>{agent}</option>)}
            </select>
          </label>
        </div>
        <div className="composer-toolbar-group">
          <span className="pill" data-kind={error ? 'warn' : 'ok'}>{error || (chatDisabled ? 'disabled' : 'ready')}</span>
          <button className="composer-send" type="submit" disabled={isSending || !canSend || chatDisabled} aria-label="Send message">
            <span className="sr-only">Send message</span>
          </button>
        </div>
      </div>
    </>
  )
}

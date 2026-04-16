import type { RefObject } from 'react'

type ChatInputToolbarProps = {
  fileInputRef: RefObject<HTMLInputElement | null>
  modelButtonRef: RefObject<HTMLButtonElement | null>
  modelLabel: string
  currentDirectory: string | null
  agentMode: 'build' | 'plan'
  currentSessionId: string | null
  isGenerating: boolean
  isAwaitingPermission: boolean
  isAwaitingQuestion: boolean
  canSend: boolean
  onAddFiles: (files: FileList | File[]) => Promise<void> | void
  onToggleModelMenu: () => void
  onToggleAgentMode: () => void
  onFork: () => Promise<void> | void
  onStop: () => Promise<void> | void
  onSubmit: () => Promise<void> | void
}

export function ChatInputToolbar({
  fileInputRef,
  modelButtonRef,
  modelLabel,
  currentDirectory,
  agentMode,
  currentSessionId,
  isGenerating,
  isAwaitingPermission,
  isAwaitingQuestion,
  canSend,
  onAddFiles,
  onToggleModelMenu,
  onToggleAgentMode,
  onFork,
  onStop,
  onSubmit,
}: ChatInputToolbarProps) {
  return (
    <div className="flex items-center justify-between px-3 pb-2.5 pt-0.5">
      <div className="flex items-center gap-1">
        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors cursor-pointer"
          title="Attach file"
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <line x1="7.5" y1="3" x2="7.5" y2="12" />
            <line x1="3" y1="7.5" x2="12" y2="7.5" />
          </svg>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.target.files) {
              void onAddFiles(event.target.files)
            }
            event.target.value = ''
          }}
        />

        <div>
          <button
            ref={modelButtonRef}
            onClick={onToggleModelMenu}
            className="px-2.5 py-1 rounded-lg text-[11px] font-medium text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-all cursor-pointer flex items-center gap-1"
          >
            {modelLabel}
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.2">
              <polyline points="2,3 4,5.5 6,3" />
            </svg>
          </button>
        </div>

        {currentDirectory ? (
          <span
            className="px-2 py-1 rounded-lg text-[10px] text-text-muted flex items-center gap-1 truncate"
            style={{ maxWidth: 160 }}
            title={currentDirectory}
          >
            <svg width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" className="shrink-0">
              <path d="M2 3.5C2 2.67 2.67 2 3.5 2H5.5L7 3.5H10.5C11.33 3.5 12 4.17 12 5V10.5C12 11.33 11.33 12 10.5 12H3.5C2.67 12 2 11.33 2 10.5V3.5Z" />
            </svg>
            {currentDirectory.split('/').pop()}
          </span>
        ) : null}

        <button
          onClick={onToggleAgentMode}
          className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all cursor-pointer flex items-center gap-1 ${
            agentMode === 'plan'
              ? 'bg-amber/15 text-amber'
              : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover'
          }`}
          title={agentMode === 'plan' ? 'Plan mode: read-only analysis and audits' : 'Build mode: full-access work and delegation'}
        >
          {agentMode === 'plan' ? 'Plan' : 'Build'}
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.2">
            <polyline points="2,3 4,5.5 6,3" />
          </svg>
        </button>
      </div>

      <div className="flex items-center gap-1.5">
        {currentSessionId && !isGenerating && !isAwaitingPermission && !isAwaitingQuestion ? (
          <button
            onClick={() => void onFork()}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors cursor-pointer"
            title="Fork thread"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <line x1="7" y1="2" x2="7" y2="8" />
              <line x1="4" y1="5" x2="7" y2="8" />
              <line x1="10" y1="5" x2="7" y2="8" />
              <line x1="4" y1="8" x2="4" y2="12" />
              <line x1="10" y1="8" x2="10" y2="12" />
            </svg>
          </button>
        ) : null}

        {isGenerating ? (
          <button
            onClick={() => void onStop()}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-text-muted hover:text-red hover:bg-red/10 transition-colors cursor-pointer"
            title="Stop generating (Esc)"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <rect x="3" y="3" width="8" height="8" rx="1.5" />
            </svg>
          </button>
        ) : null}

        {isAwaitingPermission && !isGenerating ? (
          <div
            className="px-2 py-1 rounded-lg text-[10px] font-medium"
            style={{
              color: 'var(--color-amber)',
              background: 'color-mix(in srgb, var(--color-amber) 14%, transparent)',
            }}
            title="Approve or deny the pending tool request to continue"
          >
            Awaiting approval
          </div>
        ) : null}

        {isAwaitingQuestion && !isGenerating ? (
          <div
            className="px-2 py-1 rounded-lg text-[10px] font-medium"
            style={{
              color: 'var(--color-accent)',
              background: 'color-mix(in srgb, var(--color-accent) 14%, transparent)',
            }}
            title="Answer the pending question to continue"
          >
            Awaiting answer
          </div>
        ) : null}

        <button
          onClick={() => void (isGenerating ? onStop() : onSubmit())}
          disabled={!canSend && !isGenerating}
          className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all cursor-pointer ${
            isGenerating
              ? 'bg-transparent text-text-muted hover:text-red'
              : canSend
                ? 'bg-text text-base'
                : 'bg-transparent text-text-muted opacity-40'
          }`}
        >
          {isGenerating ? (
            <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="7" y1="11" x2="7" y2="3" />
              <polyline points="3.5,6 7,2.5 10.5,6" />
            </svg>
          )}
        </button>
      </div>
    </div>
  )
}

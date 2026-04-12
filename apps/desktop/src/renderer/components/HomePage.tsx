import { useMemo } from 'react'
import { useSessionStore } from '../stores/session'
import { loadSessionMessages } from '../helpers/loadSessionMessages'

export function HomePage({ onOpenThread }: { onOpenThread: () => void }) {
  const sessions = useSessionStore((s) => s.sessions)
  const addSession = useSessionStore((s) => s.addSession)
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession)
  const busySessions = useSessionStore((s) => s.busySessions)

  const recentSessions = useMemo(() => sessions.slice(0, 6), [sessions])

  const suggestions = [
    { icon: '📊', text: 'Analyze last week\'s sales data' },
    { icon: '📝', text: 'Create a project status report' },
    { icon: '📧', text: 'Draft an update email with the latest KPI summary' },
    { icon: '📅', text: 'Summarize my calendar priorities for today' },
  ]

  const createThread = async (directory?: string, prompt?: string) => {
    let sessionId: string | null = null
    try {
      const session = await window.cowork.session.create(directory)
      sessionId = session.id
      addSession(session)
      setCurrentSession(session.id)
      onOpenThread()

      if (prompt) {
        const store = useSessionStore.getState()
        store.addMessage(session.id, {
          id: crypto.randomUUID(),
          role: 'user',
          content: prompt,
        })
        store.addBusy(session.id)
        store.setIsGenerating(true)
        await window.cowork.session.prompt(session.id, prompt, undefined, 'cowork')
      }
    } catch (err) {
      console.error('Failed to create thread:', err)
      const store = useSessionStore.getState()
      if (sessionId) {
        store.removeBusy(sessionId)
      }
      store.setIsGenerating(false)
    }
  }

  const openRecentThread = async (sessionId: string) => {
    onOpenThread()
    await loadSessionMessages(sessionId)
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[980px] mx-auto px-8 py-10">
        <div className="rounded-[28px] border border-border-subtle overflow-hidden" style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--color-base) 92%, var(--color-accent) 8%), color-mix(in srgb, var(--color-base) 96%, var(--color-text) 4%))' }}>
          <div className="px-8 py-8 border-b border-border-subtle">
            <div className="flex items-start justify-between gap-6 flex-wrap">
              <div className="max-w-[560px]">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-[11px] font-medium border border-border-subtle text-text-secondary bg-surface/60">
                  <span className="w-2 h-2 rounded-full bg-accent" />
                  Cowork Home
                </div>
                <h1 className="mt-4 text-[32px] leading-[1.05] font-semibold text-text">
                  Start from a clean home base, then open the right thread when you need it.
                </h1>
                <p className="mt-3 text-[14px] leading-relaxed text-text-secondary">
                  Use Cowork for new business workflows, jump back into recent threads, or open a project directory for file-based work.
                </p>
              </div>

              <div className="grid gap-3 min-w-[260px]">
                <button
                  onClick={() => createThread()}
                  className="flex items-center justify-between gap-3 rounded-2xl border border-border-subtle px-4 py-3 text-left bg-surface hover:bg-surface-hover transition-colors cursor-pointer"
                >
                  <div>
                    <div className="text-[13px] font-medium text-text">New Sandbox Thread</div>
                    <div className="mt-1 text-[11px] text-text-muted">Data, docs, email, Workspace tools</div>
                  </div>
                  <span className="text-text-muted">+</span>
                </button>

                <button
                  onClick={async () => {
                    const dir = await window.cowork.dialog.selectDirectory()
                    if (dir) createThread(dir)
                  }}
                  className="flex items-center justify-between gap-3 rounded-2xl border border-border-subtle px-4 py-3 text-left bg-surface hover:bg-surface-hover transition-colors cursor-pointer"
                >
                  <div>
                    <div className="text-[13px] font-medium text-text">Open Project</div>
                    <div className="mt-1 text-[11px] text-text-muted">Pick a directory for code and file work</div>
                  </div>
                  <span className="text-text-muted">→</span>
                </button>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)] gap-0 max-[900px]:grid-cols-1">
            <section className="px-8 py-7 border-r border-border-subtle max-[900px]:border-r-0 max-[900px]:border-b">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">Quick Starts</div>
              <div className="mt-4 grid grid-cols-2 gap-3 max-[680px]:grid-cols-1">
                {suggestions.map((suggestion, index) => (
                  <button
                    key={index}
                    onClick={() => createThread(undefined, suggestion.text)}
                    className="flex items-start gap-3 rounded-2xl border border-border-subtle bg-surface px-4 py-4 text-left hover:bg-surface-hover transition-colors cursor-pointer"
                  >
                    <span className="text-[18px] leading-none mt-0.5">{suggestion.icon}</span>
                    <span className="text-[13px] leading-snug text-text-secondary">{suggestion.text}</span>
                  </button>
                ))}
              </div>
            </section>

            <section className="px-8 py-7">
              <div className="flex items-center justify-between gap-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">Recent Threads</div>
                <div className="text-[11px] text-text-muted">{sessions.length} total</div>
              </div>

              {recentSessions.length > 0 ? (
                <div className="mt-4 flex flex-col gap-2.5">
                  {recentSessions.map((session) => {
                    const isBusy = busySessions.has(session.id)
                    return (
                      <button
                        key={session.id}
                        onClick={() => openRecentThread(session.id)}
                        className="w-full rounded-2xl border border-border-subtle bg-surface px-4 py-3 text-left hover:bg-surface-hover transition-colors cursor-pointer"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 min-w-0">
                              {isBusy && <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" />}
                              <span className="text-[13px] font-medium text-text truncate">{session.title || `Thread ${session.id.slice(0, 6)}`}</span>
                            </div>
                            {session.directory && (
                              <div className="mt-1 text-[11px] text-text-muted truncate">{session.directory.split('/').slice(-2).join('/')}</div>
                            )}
                          </div>
                          <span className="text-[11px] text-text-muted shrink-0">Open</span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div className="mt-4 rounded-2xl border border-dashed border-border-subtle px-4 py-6 text-[12px] text-text-muted">
                  No threads yet. Start with a sandbox workflow or open a project.
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}

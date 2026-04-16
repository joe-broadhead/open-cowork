import { useEffect, useMemo, useRef, useState } from 'react'

export type ChatInputModelEntry = {
  id: string
  label: string
  featured?: boolean
}

type ChatInputModelMenuProps = {
  visible: boolean
  anchorRect: DOMRect | null
  models: ChatInputModelEntry[]
  currentModel: string
  onClose: () => void
  onSelect: (modelId: string) => void | Promise<void>
}

// Above this count we flip the model menu into a searchable list. Matches
// the Settings panel threshold so both places feel consistent.
const SEARCH_THRESHOLD = 20
const MENU_WIDTH = 320
const MENU_MAX_HEIGHT = 360

export function ChatInputModelMenu({
  visible,
  anchorRect,
  models,
  currentModel,
  onClose,
  onSelect,
}: ChatInputModelMenuProps) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const useSearch = models.length > SEARCH_THRESHOLD

  // Reset search every time the menu re-opens so the previous filter
  // doesn't bleed into the next interaction.
  useEffect(() => {
    if (visible) {
      setQuery('')
      if (useSearch) {
        // Autofocus after the portal mounts so the user can type immediately.
        requestAnimationFrame(() => inputRef.current?.focus())
      }
    }
  }, [visible, useSearch])

  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return models
    return models.filter((model) => {
      return `${model.id} ${model.label}`.toLowerCase().includes(trimmed)
    })
  }, [models, query])

  if (!visible || !anchorRect) return null

  // Clamp the menu into the viewport. Prefer anchoring above the chat
  // input, but fall back to below it when there's no room — and in either
  // case keep the final `top` inside the visible window on very short
  // displays so the menu never renders offscreen.
  const viewportHeight = window.innerHeight
  const desiredHeight = Math.min(
    MENU_MAX_HEIGHT + (useSearch ? 52 : 32),
    filtered.length * 40 + (useSearch ? 52 : 32) + 8,
  )
  const above = anchorRect.top - desiredHeight - 4
  const below = anchorRect.bottom + 4
  const preferred = above >= 8 ? above : below
  const top = Math.max(
    8,
    Math.min(preferred, viewportHeight - desiredHeight - 8),
  )
  const left = Math.min(
    anchorRect.left,
    Math.max(8, window.innerWidth - MENU_WIDTH - 8),
  )

  const hasFeatured = filtered.some((model) => model.featured)

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 rounded-xl border shadow-xl overflow-hidden flex flex-col"
        style={{
          background: 'var(--color-base)',
          borderColor: 'var(--color-border)',
          width: MENU_WIDTH,
          maxHeight: desiredHeight,
          left,
          top,
        }}
      >
        <div
          className="px-3 py-2 text-[11px] text-text-muted font-medium border-b flex items-center justify-between"
          style={{ borderColor: 'var(--color-border-subtle)' }}
        >
          <span>Model</span>
          <span className="text-[10px] text-text-muted font-normal">
            {filtered.length === models.length
              ? `${models.length}`
              : `${filtered.length} / ${models.length}`}
          </span>
        </div>
        {useSearch && (
          <div className="px-2 py-2 border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search models…"
              className="w-full px-2 py-1 rounded-md text-[12px] bg-elevated border border-border-subtle text-text outline-none focus:border-accent"
            />
          </div>
        )}
        <div className="overflow-y-auto flex-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-[12px] text-text-muted text-center">No matches.</div>
          ) : (
            filtered.map((model, index) => {
              const isActive = currentModel === model.id
              const showFeaturedBoundary =
                hasFeatured && index > 0 && filtered[index - 1].featured && !model.featured
              return (
                <div key={model.id}>
                  {showFeaturedBoundary && (
                    <div
                      className="px-3 py-1 text-[10px] uppercase tracking-[0.08em] text-text-muted"
                      style={{ background: 'var(--color-surface-hover)' }}
                    >
                      All models
                    </div>
                  )}
                  <button
                    onClick={() => void onSelect(model.id)}
                    className="w-full text-left px-3 py-2 text-[12px] cursor-pointer transition-colors hover:bg-surface-hover flex items-center justify-between gap-2"
                    style={{
                      color: 'var(--color-text)',
                      background: isActive ? 'color-mix(in srgb, var(--color-accent) 10%, transparent)' : 'transparent',
                    }}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate">{model.label}</span>
                        {model.featured && (
                          <span
                            className="shrink-0 text-[9px] uppercase tracking-[0.04em] px-1 py-px rounded"
                            style={{
                              color: 'var(--color-accent)',
                              background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
                            }}
                          >
                            Featured
                          </span>
                        )}
                      </span>
                      {model.id !== model.label && (
                        <span className="block text-[10px] text-text-muted font-mono truncate">
                          {model.id}
                        </span>
                      )}
                    </span>
                    {isActive ? (
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--color-text)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                        <polyline points="3,7.5 6,10.5 11,4" />
                      </svg>
                    ) : null}
                  </button>
                </div>
              )
            })
          )}
        </div>
      </div>
    </>
  )
}

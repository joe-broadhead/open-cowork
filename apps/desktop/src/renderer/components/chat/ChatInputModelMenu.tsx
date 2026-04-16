type ChatInputModelMenuProps = {
  visible: boolean
  anchorRect: DOMRect | null
  models: Array<{ id: string; label: string }>
  currentModel: string
  onClose: () => void
  onSelect: (modelId: string) => void | Promise<void>
}

export function ChatInputModelMenu({
  visible,
  anchorRect,
  models,
  currentModel,
  onClose,
  onSelect,
}: ChatInputModelMenuProps) {
  if (!visible || !anchorRect) return null

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 w-52 rounded-xl border shadow-xl overflow-hidden"
        style={{
          background: 'var(--color-base)',
          borderColor: 'var(--color-border)',
          left: anchorRect.left,
          top: anchorRect.top - (models.length * 34 + 40),
        }}
      >
        <div
          className="px-3 py-2 text-[11px] text-text-muted font-medium border-b"
          style={{ borderColor: 'var(--color-border-subtle)' }}
        >
          Model
        </div>
        {models.map((model) => (
          <button
            key={model.id}
            onClick={() => void onSelect(model.id)}
            className="w-full text-left px-3 py-2 text-[13px] cursor-pointer transition-colors hover:bg-surface-hover flex items-center justify-between"
            style={{ color: 'var(--color-text)' }}
          >
            {model.label}
            {currentModel === model.id ? (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--color-text)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3,7.5 6,10.5 11,4" />
              </svg>
            ) : null}
          </button>
        ))}
      </div>
    </>
  )
}

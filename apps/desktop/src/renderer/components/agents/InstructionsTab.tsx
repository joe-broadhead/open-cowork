import { useState } from 'react'
import { ModalBackdrop } from '../layout/ModalBackdrop'

type Props = {
  value: string
  onChange: (next: string) => void
  readOnly?: boolean
}

// Reusable starter snippets the user can prepend to the instructions.
// Kept small and opinionated — a business user shouldn't have to invent
// prompt-engineering from scratch.
const SNIPPETS: Array<{ id: string; label: string; body: string }> = [
  {
    id: 'concise',
    label: 'Be concise',
    body: 'Answer in 3–5 bullets. Keep prose tight. Cut anything that isn\'t load-bearing.',
  },
  {
    id: 'ask-first',
    label: 'Ask clarifying questions',
    body: 'If the request is ambiguous, ask one clarifying question before taking action.',
  },
  {
    id: 'cite',
    label: 'Cite sources',
    body: 'When summarising findings, cite each claim against the source document or URL.',
  },
  {
    id: 'draft-only',
    label: 'Draft, never send',
    body: 'Produce drafts only. Never send messages, emails, or external actions without confirmation.',
  },
  {
    id: 'structured',
    label: 'Structured output',
    body: 'Return results as a short executive summary, then a numbered breakdown.',
  },
]

export function InstructionsTab({ value, onChange, readOnly }: Props) {
  const [menuOpen, setMenuOpen] = useState(false)

  const prepend = (snippet: string) => {
    const joined = value.trim() ? `${snippet}\n\n${value}` : snippet
    onChange(joined)
    setMenuOpen(false)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-text-muted leading-relaxed">
          Shape tone, priorities, and output format. Good instructions are specific and operational.
        </div>
        {!readOnly && (
          <div className="relative shrink-0">
            <button
              onClick={() => setMenuOpen((open) => !open)}
              className="text-[11px] px-2 py-1 rounded-full border border-border-subtle text-text-muted hover:text-text hover:bg-surface-hover cursor-pointer"
            >
              + Snippet
            </button>
            {menuOpen && (
              <>
                <ModalBackdrop onDismiss={() => setMenuOpen(false)} className="fixed inset-0 z-40" />
                <div
                  className="absolute right-0 top-full mt-1 z-50 w-60 rounded-xl border shadow-xl overflow-hidden"
                  style={{
                    background: 'var(--color-base)',
                    borderColor: 'var(--color-border)',
                  }}
                >
                  {SNIPPETS.map((snippet) => (
                    <button
                      key={snippet.id}
                      onClick={() => prepend(snippet.body)}
                      className="w-full text-left px-3 py-2 text-[12px] hover:bg-surface-hover transition-colors cursor-pointer border-b border-border-subtle last:border-b-0"
                    >
                      <div className="font-medium text-text">{snippet.label}</div>
                      <div className="text-[10px] text-text-muted mt-0.5 line-clamp-2">
                        {snippet.body}
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        readOnly={readOnly}
        rows={16}
        placeholder={readOnly
          ? 'No instructions.'
          : 'Examples:\n- Summarize findings as 3 bullets plus evidence.\n- Prefer official docs over blogs.\n- Never send email; draft only.\n- Ask for approval before any external write.'}
        className="w-full px-3 py-2 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border resize-y leading-relaxed"
        style={{ minHeight: 280 }}
      />

      <div className="text-[10px] text-text-muted flex items-center justify-between">
        <span>{value.trim().length} chars</span>
        {value.trim().length > 2000 && (
          <span style={{ color: 'var(--color-amber)' }}>
            Long prompts burn tokens — consider trimming
          </span>
        )}
      </div>
    </div>
  )
}

import { useState } from 'react'

interface ParsedQuestion {
  question: string
  options: Array<{ index: number; text: string; recommended: boolean }>
}

export function parseQuestions(text: string): { before: string; questions: ParsedQuestion[]; after: string } {
  const regex = /\[QUESTION\]\s*\n(.*?)\n\[OPTIONS\]\s*\n([\s\S]*?)\n\[\/QUESTION\]/g
  const questions: ParsedQuestion[] = []
  let lastEnd = 0
  let before = ''
  let match

  while ((match = regex.exec(text)) !== null) {
    if (questions.length === 0) before = text.slice(0, match.index)
    const question = match[1].trim()
    const optionsRaw = match[2].trim()
    const options = optionsRaw.split('\n').map(line => {
      const m = line.match(/^(\d+)\.\s*(.+)$/)
      if (!m) return null
      const text = m[2].trim()
      return {
        index: parseInt(m[1]),
        text: text.replace(/\s*\(Recommended\)\s*/i, ''),
        recommended: /\(Recommended\)/i.test(text),
      }
    }).filter(Boolean) as ParsedQuestion['options']

    questions.push({ question, options })
    lastEnd = match.index + match[0].length
  }

  const after = lastEnd > 0 ? text.slice(lastEnd).trim() : ''
  if (questions.length === 0) before = text

  return { before, questions, after }
}

export function hasQuestionFormat(text: string): boolean {
  return /\[QUESTION\]/.test(text) && /\[\/QUESTION\]/.test(text)
}

interface Props {
  question: ParsedQuestion
  onSelect: (answer: string) => void
}

export function QuestionCard({ question, onSelect }: Props) {
  const [selected, setSelected] = useState<number | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const handleSubmit = () => {
    if (selected === null) return
    const option = question.options.find(o => o.index === selected)
    if (!option) return
    setSubmitted(true)
    onSelect(option.text)
  }

  const handleDismiss = () => {
    setSubmitted(true)
    onSelect('Skip this question')
  }

  if (submitted) {
    const chosen = question.options.find(o => o.index === selected)
    return (
      <div className="rounded-xl border border-border-subtle p-4 text-[13px]" style={{ background: 'var(--color-elevated)' }}>
        <div className="font-medium text-text mb-2">{question.question}</div>
        <div className="text-text-secondary">
          {chosen ? `→ ${chosen.text}` : 'Skipped'}
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-border p-4" style={{ background: 'var(--color-elevated)' }}>
      <div className="text-[13px] font-semibold text-text mb-3">{question.question}</div>
      <div className="flex flex-col gap-1.5 mb-4">
        {question.options.map(opt => (
          <button
            key={opt.index}
            onClick={() => setSelected(opt.index)}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-[13px] text-left cursor-pointer transition-all ${
              selected === opt.index
                ? 'bg-accent/10 border border-accent/30 text-text'
                : 'border border-border-subtle text-text-secondary hover:border-border hover:text-text'
            }`}
          >
            <div className={`w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors ${
              selected === opt.index ? 'border-accent' : 'border-text-muted'
            }`}>
              {selected === opt.index && <div className="w-2 h-2 rounded-full bg-accent" />}
            </div>
            <span>
              {opt.index}. {opt.text}
              {opt.recommended && (
                <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ color: 'var(--color-green)', background: 'color-mix(in srgb, var(--color-green) 12%, transparent)' }}>
                  Recommended
                </span>
              )}
            </span>
          </button>
        ))}
      </div>
      <div className="flex items-center justify-end gap-2">
        <button onClick={handleDismiss}
          className="px-3 py-1.5 rounded-lg text-[12px] text-text-muted hover:text-text-secondary cursor-pointer transition-colors">
          Dismiss <kbd className="ml-1 px-1 py-0.5 rounded bg-surface-hover text-[9px] font-mono">ESC</kbd>
        </button>
        <button onClick={handleSubmit} disabled={selected === null}
          className="px-4 py-1.5 rounded-lg text-[12px] font-medium cursor-pointer transition-all"
          style={{
            background: selected !== null ? 'var(--color-accent)' : 'var(--color-surface-hover)',
            color: selected !== null ? '#fff' : 'var(--color-text-muted)',
          }}>
          Submit <kbd className="ml-1 px-1 py-0.5 rounded text-[9px] font-mono" style={{ background: 'rgba(255,255,255,0.15)' }}>↵</kbd>
        </button>
      </div>
    </div>
  )
}

import { useState } from 'react'

export interface ParsedInputQuestion {
  index: number
  label: string
  hint: string
}

/**
 * Detect numbered question lists like:
 * 1. **BigQuery data source** — What table or query?
 * 2. **Target Sheet** — New or existing?
 *
 * Returns null if the text doesn't look like a question list.
 */
export function parseInputQuestions(text: string): { preamble: string; questions: ParsedInputQuestion[]; postamble: string } | null {
  const lines = text.split('\n')

  // Find runs of numbered items that look like questions
  const questionLines: { index: number; label: string; hint: string; lineIdx: number }[] = []
  // Match patterns like: "1. **Label** — hint" or "1. Label — hint" or "1. Label: hint"
  const qRegex = /^(\d+)\.\s+\*{0,2}([^*—:\n]+?)\*{0,2}\s*[—:\-–]\s*(.+)$/

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(qRegex)
    if (m) {
      questionLines.push({ index: parseInt(m[1]), label: m[2].trim(), hint: m[3].trim(), lineIdx: i })
    }
  }

  // Need at least 2 questions to render as a form
  if (questionLines.length < 2) return null

  // Check they're consecutive-ish (within 2 lines of each other)
  const firstLine = questionLines[0].lineIdx
  const lastLine = questionLines[questionLines.length - 1].lineIdx
  const span = lastLine - firstLine + 1
  if (span > questionLines.length * 3) return null // Too spread out, not a question block

  // Find the line that introduces the questions (e.g. "Key questions:" or "I need a few details:")
  let preambleEnd = firstLine
  // Look backwards for the intro line
  for (let i = firstLine - 1; i >= Math.max(0, firstLine - 3); i--) {
    const line = lines[i].trim()
    if (line && (line.endsWith(':') || line.endsWith('?'))) {
      preambleEnd = i
      break
    }
  }

  const preamble = lines.slice(0, preambleEnd).join('\n').trim()
  const postamble = lines.slice(lastLine + 1).join('\n').trim()
  const questions = questionLines.map(q => ({ index: q.index, label: q.label, hint: q.hint }))

  return { preamble, questions, postamble }
}

export function hasInputQuestions(text: string): boolean {
  return parseInputQuestions(text) !== null
}

interface Props {
  questions: ParsedInputQuestion[]
  introText?: string
  onSubmit: (answers: string) => void
}

export function InputFormCard({ questions, introText, onSubmit }: Props) {
  const [values, setValues] = useState<Record<number, string>>({})
  const [submitted, setSubmitted] = useState(false)

  const handleSubmit = () => {
    const answers = questions.map(q => {
      const val = values[q.index]?.trim()
      return `**${q.label}**: ${val || '(not provided)'}`
    }).join('\n')
    setSubmitted(true)
    onSubmit(answers)
  }

  const filledCount = questions.filter(q => values[q.index]?.trim()).length
  const allFilled = filledCount === questions.length

  if (submitted) {
    return (
      <div className="rounded-xl border border-border-subtle p-4 my-2" style={{ background: 'var(--color-elevated)' }}>
        {introText && <div className="text-[13px] text-text-secondary mb-2">{introText}</div>}
        {questions.map(q => (
          <div key={q.index} className="text-[12px] mb-1.5">
            <span className="font-medium text-text">{q.label}:</span>{' '}
            <span className="text-text-secondary">{values[q.index]?.trim() || '(not provided)'}</span>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-border p-4 my-2" style={{ background: 'var(--color-elevated)' }}>
      {introText && <div className="text-[13px] font-medium text-text mb-3">{introText}</div>}

      <div className="flex flex-col gap-3 mb-4">
        {questions.map(q => (
          <label key={q.index} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-medium text-text">{q.index}. {q.label}</span>
            </div>
            <input
              type="text"
              value={values[q.index] || ''}
              onChange={e => setValues(prev => ({ ...prev, [q.index]: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Enter' && allFilled) handleSubmit() }}
              placeholder={q.hint}
              className="px-3 py-2 rounded-lg text-[12px] bg-base border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-accent/40 transition-colors"
            />
          </label>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-[11px] text-text-muted">{filledCount}/{questions.length} answered</span>
        <button onClick={handleSubmit} disabled={filledCount === 0}
          className="px-4 py-1.5 rounded-lg text-[12px] font-medium cursor-pointer transition-all"
          style={{
            background: filledCount > 0 ? 'var(--color-accent)' : 'var(--color-surface-hover)',
            color: filledCount > 0 ? '#fff' : 'var(--color-text-muted)',
          }}>
          Submit <kbd className="ml-1 px-1 py-0.5 rounded text-[9px] font-mono" style={{ background: 'rgba(255,255,255,0.15)' }}>↵</kbd>
        </button>
      </div>
    </div>
  )
}

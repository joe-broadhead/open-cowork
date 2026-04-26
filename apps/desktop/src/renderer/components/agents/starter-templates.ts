import type { AgentColor, AgentStarterTemplate } from '@open-cowork/shared'
import type { AgentTemplate } from './agent-builder-utils'

// Renderer-local templates seed the builder on "New agent". Each is a
// partial CustomAgentConfig with opinionated defaults and a few
// recommended tool/skill references. References are filtered against
// the live catalog at apply-time via `applyTemplate`, so a template
// that mentions a tool the user doesn't have simply drops that ref.
//
// Kept intentionally small and business-user-oriented. Technical roles
// (dev-focused, shell-heavy) are deliberately absent — the form-style
// builder we're replacing already served developers; this set is aimed
// at the "compose a specialist" audience.
//
// The array is seeded into a mutable registry; downstream config can
// append or override via `registerExtraStarterTemplates()`.

export const STARTER_TEMPLATES: AgentTemplate[] = [
  {
    id: 'data-analyst',
    label: 'Data Analyst',
    description: 'Answer business questions with data. Query sources, summarise findings, and produce charts.',
    color: 'info',
    instructions: [
      'You are a data analyst. Business stakeholders ask you questions; you answer with evidence.',
      '',
      'How to work:',
      '- Clarify the question first if it is ambiguous (one short clarifying question, not three).',
      '- Prefer precise counts and rates over adjectives. Cite the source or query for each claim.',
      '- When a chart helps, build one. Otherwise return a short written answer.',
      '- Call out caveats (sample size, time range, segment) that change how the answer should be read.',
      '',
      'Output format:',
      '- Lead with a one-sentence executive answer.',
      '- Follow with a numbered breakdown of the supporting facts.',
      '- End with "Caveats" if any apply.',
    ].join('\n'),
    toolIds: ['charts'],
    skillNames: ['chart-creator'],
    temperature: 0.2,
    steps: 30,
  },
  {
    id: 'research-assistant',
    label: 'Research Assistant',
    description: 'Gather and synthesise information from multiple sources into concise, cited briefs.',
    color: 'accent',
    instructions: [
      'You are a research assistant. Given a topic or question, you gather sources and produce a concise brief.',
      '',
      'How to work:',
      '- Cast a wide net first, then narrow to the most credible sources.',
      '- Prefer primary / official sources over secondary commentary.',
      '- If the evidence is thin, say so — do not fabricate authority.',
      '',
      'Output format:',
      '- Three-to-five bullet executive summary at the top.',
      '- Detailed findings grouped by theme.',
      '- A Sources section with links + publication dates.',
    ].join('\n'),
    toolIds: [],
    skillNames: [],
    temperature: 0.5,
    steps: 40,
  },
  {
    id: 'writer',
    label: 'Writer',
    description: 'Draft prose — emails, memos, briefs, announcements — in your voice.',
    color: 'success',
    instructions: [
      'You are a writer. You produce drafts that sound human, specific, and direct.',
      '',
      'Style:',
      '- Plain language. Short sentences. Cut filler.',
      '- Use concrete examples over abstractions.',
      '- Match the register the user asks for (formal / casual / internal memo / external email).',
      '',
      'Process:',
      '- Ask for context if the audience is not clear (audience, length, tone).',
      '- Produce ONE draft. If the user wants alternatives, they will ask.',
      '- Draft only — never send, post, or dispatch anywhere.',
    ].join('\n'),
    toolIds: [],
    skillNames: [],
    temperature: 0.7,
    steps: 20,
  },
  {
    id: 'generalist',
    label: 'Generalist',
    description: 'Balanced starter — pick a problem, pick the tools, and customise from here.',
    color: 'secondary',
    instructions: [
      'You are a focused assistant. Answer what is asked and stop.',
      '',
      '- Clarify if ambiguous, otherwise act.',
      '- Cite your sources when making factual claims.',
      '- Keep responses proportional to the question.',
    ].join('\n'),
    toolIds: [],
    skillNames: [],
    temperature: 0.4,
    steps: 25,
  },
]

// Mutable registry seeded with the upstream starter templates.
// `registerExtraStarterTemplates()` is called by App.tsx after config loads
// so a downstream fork can append or replace templates via
// `agentStarterTemplates` in `open-cowork.config.json`. Duplicate ids
// overwrite — downstream templates with the same id as a built-in replace
// the built-in entry.
const registry: AgentTemplate[] = [...STARTER_TEMPLATES]

function coerceColor(value: string | undefined): AgentColor {
  const allowed: AgentColor[] = ['primary', 'warning', 'accent', 'success', 'info', 'secondary']
  return allowed.includes(value as AgentColor) ? value as AgentColor : 'accent'
}

function normalizeTemplate(entry: AgentStarterTemplate): AgentTemplate {
  return {
    id: entry.id,
    label: entry.label,
    description: entry.description,
    color: coerceColor(entry.color),
    instructions: entry.instructions,
    temperature: entry.temperature ?? null,
    steps: entry.steps ?? null,
    toolIds: entry.toolIds || [],
    skillNames: entry.skillNames || [],
  }
}

export function registerExtraStarterTemplates(entries: AgentStarterTemplate[] | null | undefined) {
  if (!Array.isArray(entries)) return
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string') continue
    const normalized = normalizeTemplate(entry)
    const existingIndex = registry.findIndex((template) => template.id === normalized.id)
    if (existingIndex >= 0) registry[existingIndex] = normalized
    else registry.push(normalized)
  }
}

export function getStarterTemplates(): AgentTemplate[] {
  return registry.slice()
}

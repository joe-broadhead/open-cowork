import { useSessionStore } from '../../stores/session'

const AGENT_LABELS: Record<string, string> = {
  analyst: 'Analyst is analyzing',
  workspace: 'Workspace is working',
  build: 'Building',
  plan: 'Planning',
  explore: 'Exploring',
}

export function ThinkingIndicator() {
  const activeAgent = useSessionStore((s) => s.activeAgent)
  const label = activeAgent ? AGENT_LABELS[activeAgent] || `${activeAgent} is working` : 'Thinking'

  return (
    <div className="flex items-center gap-2 py-2">
      <span className="thinking-shimmer text-[13px] font-medium">{label}</span>
    </div>
  )
}

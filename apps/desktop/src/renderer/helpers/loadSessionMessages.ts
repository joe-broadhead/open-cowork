import { useSessionStore } from '../stores/session'

export async function loadSessionMessages(sessionId: string) {
  const store = useSessionStore.getState()
  try {
    const items = await window.cowork.session.messages(sessionId)
    for (const item of items) {
      if ((item as any).type === 'tool' && (item as any).tool) {
        const tool = (item as any).tool
        store.addToolCall({
          id: item.id,
          name: tool.name,
          input: tool.input,
          status: tool.status as 'running' | 'complete' | 'error',
          output: tool.output,
        })
      } else if ((item as any).type === 'cost' && (item as any).cost) {
        const cost = (item as any).cost
        store.addCost(cost.cost, cost.tokens)
      } else {
        store.addMessage({
          id: item.id,
          role: ((item as any).role || 'assistant') as 'user' | 'assistant',
          content: (item as any).content || '',
        })
      }
    }
  } catch {}
}

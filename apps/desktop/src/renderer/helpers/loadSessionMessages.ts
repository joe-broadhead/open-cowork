import { useSessionStore } from '../stores/session'

/**
 * Atomically switch to a session: clear current state, set session ID, load history.
 * Prevents duplicate messages from append-based loading.
 */
export async function switchToSession(sessionId: string) {
  const store = useSessionStore.getState()

  // Atomic: clear + set in one operation
  store.setCurrentSession(sessionId)

  try {
    const items = await window.cowork.session.messages(sessionId)
    for (const item of items) {
      if (item.type === 'tool' && item.tool) {
        store.addToolCall({
          id: item.id,
          name: item.tool.name,
          input: item.tool.input,
          status: item.tool.status as 'running' | 'complete' | 'error',
          output: item.tool.output,
        })
      } else if (item.type === 'cost' && item.cost) {
        store.addCost(item.cost.cost, item.cost.tokens)
      } else if (item.role) {
        store.addMessage({
          id: item.id,
          role: (item.role || 'assistant') as 'user' | 'assistant',
          content: item.content || '',
        })
      }
    }
  } catch (err) {
    console.error('[switchToSession] Failed to load messages:', err)
  }
}

// Backward compat alias
export const loadSessionMessages = switchToSession

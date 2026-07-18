import {
  clearChannelBindingsForTest,
  deleteChannelBinding,
  getChannelBinding,
  listChannelBindings,
  listChannelBindingsReadOnly,
  upsertChannelBinding,
  type ChannelBindingMode,
  type ChannelBindingRecord,
} from './work-store.js'

export interface ChannelSessionLink extends ChannelBindingRecord {}

export function getChannelSession(provider: string, chatId: string, threadId?: string, filePath?: string): string | undefined {
  return getChannelBinding(provider, chatId, threadId, filePath)?.sessionId
    || listChannelSessions({ provider, chatId, threadId }, filePath)[0]?.sessionId
}

export function setChannelSession(provider: string, chatId: string, sessionId: string, options: {
  threadId?: string
  mode?: ChannelBindingMode
  roadmapId?: string
  taskId?: string
  title?: string
} = {}, filePath?: string): ChannelSessionLink {
  return upsertChannelBinding({ provider, chatId, sessionId, ...options }, filePath)
}

export function listChannelSessions(filter: { provider?: string; chatId?: string; threadId?: string; sessionId?: string } = {}, filePath?: string): ChannelSessionLink[] {
  return applyChannelSessionFilter(listChannelBindings({}, filePath), filter)
}

export function listChannelSessionsReadOnly(filter: { provider?: string; chatId?: string; threadId?: string; sessionId?: string } = {}, filePath?: string): ChannelSessionLink[] {
  return applyChannelSessionFilter(listChannelBindingsReadOnly({}, filePath), filter)
}

export function clearChannelSession(provider: string, chatId: string, threadId?: string, filePath?: string): boolean {
  return deleteChannelBinding(provider, chatId, threadId, filePath)
}

export function clearChannelSessionsForTest(filePath?: string): void {
  clearChannelBindingsForTest(filePath)
}

function applyChannelSessionFilter(bindings: ChannelSessionLink[], filter: { provider?: string; chatId?: string; threadId?: string; sessionId?: string }): ChannelSessionLink[] {
  const seen = new Set<string>()
  return bindings
    .filter(binding => !filter.provider || binding.provider === filter.provider)
    .filter(binding => !filter.chatId || binding.chatId === filter.chatId)
    .filter(binding => filter.threadId === undefined || (binding.threadId || '') === (filter.threadId || ''))
    .filter(binding => !filter.sessionId || binding.sessionId === filter.sessionId)
    .filter(binding => {
      const key = `${binding.provider}:${binding.chatId}:${binding.threadId || ''}:${binding.sessionId}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

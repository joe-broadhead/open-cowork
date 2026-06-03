import { resolveDisplayCostForModel } from './pricing-core.ts'
import type {
  NormalizedMessagePart,
  NormalizedSessionMessage,
} from './opencode-adapter.ts'

export const toHistorySortTime = (value?: number, fallback = 0) => {
  const raw = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return raw < 1_000_000_000_000 ? raw * 1000 : raw
}

export const collectHistoryTextParts = (parts: NormalizedMessagePart[]) => {
  const textParts: NormalizedMessagePart[] = []
  let fullText = ''

  for (const part of parts) {
    if (part.type !== 'text' || typeof part.text !== 'string' || part.text.length === 0) continue
    textParts.push(part)
    fullText += part.text
  }

  return { textParts, fullText }
}

export const createHistoryCostPayload = (cachedModelId: string, part: NormalizedMessagePart) => {
  const tokens = part.tokens || { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  const cost = resolveDisplayCostForModel(cachedModelId, part.cost ?? undefined, tokens)
  return {
    cost,
    tokens: {
      input: tokens.input || 0,
      output: tokens.output || 0,
      reasoning: tokens.reasoning || 0,
      cache: { read: tokens.cache?.read || 0, write: tokens.cache?.write || 0 },
    },
  }
}

export const getHistoryModelMeta = (message: NormalizedSessionMessage) => ({
  providerId: message.info.model.providerId,
  modelId: message.info.model.modelId,
})

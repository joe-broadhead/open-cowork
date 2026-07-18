export type ProviderTargetReplacement = (input: { provider: string; chatId: string; threadId?: string }) => string
export type TextReplacement = (value: string) => string

const CHANNEL_TARGET_TEXT_PATTERN = /\b(telegram|whatsapp|discord):([^\s"'`,;()]+)(?::([^\s"'`,;()]+))?/gi
const SESSION_ID_TEXT_PATTERN = /\bses[_A-Za-z0-9-]+\b/g
const PRIVATE_TEXT_PATTERN = /\b(private\s+(?:transcript|prompt|message|body)(?:\s+body)?)(?:\s+[^\n.;]*)?/gi
const PHONE_LIKE_PATTERN = /(?<![A-Za-z0-9_])\+?\d[\d .()-]{7,}\d(?![A-Za-z0-9_])/g

export function replaceProviderTargetText(value: string, replace: ProviderTargetReplacement): string {
  return value.replace(CHANNEL_TARGET_TEXT_PATTERN, (_match, provider, chatId, threadId) => replace({ provider, chatId, threadId }))
}

export function replaceSessionIdText(value: string, replace: TextReplacement): string {
  return value.replace(SESSION_ID_TEXT_PATTERN, match => replace(match))
}

export function replacePrivateText(value: string, replace: TextReplacement): string {
  return value.replace(PRIVATE_TEXT_PATTERN, match => replace(match))
}

export function replacePhoneLikeText(value: string, replace: TextReplacement): string {
  return value.replace(PHONE_LIKE_PATTERN, match => replace(match))
}

/**
 * Native (session.next) message-family handlers.
 * Split from event-message-handlers.ts (JOE-884) so classic and native
 * projection domains can evolve independently under size budgets.
 */
import type { BrowserWindow } from 'electron'
import {
  normalizeToolAttachments,
  normalizeToolOutputPaths,
} from '@open-cowork/runtime-host'
import { asRecord, readRecordValue, readString } from '@open-cowork/shared'
import {
  handleMessagePartDeltaEvent,
  handleMessagePartUpdatedEvent,
  markNativeMessageOwned,
  markNativeToolOwned,
  MAX_TOTAL_MESSAGE_ROLES,
  setMessageRole,
  type DispatchRuntimeEvent,
  type SessionScopedMessageState,
} from './event-message-handlers.ts'

function nativeMessageEventFields(properties: Record<string, unknown> | null | undefined) {
  return {
    sessionID: readString(readRecordValue(properties, 'sessionID')) || null,
    messageID: readString(readRecordValue(properties, 'assistantMessageID')) || null,
  }
}

export function handleNativeTextDeltaEvent(
  win: BrowserWindow,
  dispatchRuntimeEvent: DispatchRuntimeEvent,
  properties: Record<string, unknown> | null | undefined,
  messageState: SessionScopedMessageState,
  kind: 'text' | 'reasoning',
) {
  const { sessionID, messageID } = nativeMessageEventFields(properties)
  const partID = readString(readRecordValue(properties, kind === 'text' ? 'textID' : 'reasoningID'))
  const delta = readString(readRecordValue(properties, 'delta'))
  if (!sessionID || !messageID || !delta) return
  setMessageRole(messageState, sessionID, messageID, 'assistant')
  markNativeMessageOwned(messageState, sessionID, messageID)
  handleMessagePartDeltaEvent(win, dispatchRuntimeEvent, {
    sessionID,
    messageID,
    partID,
    type: kind,
    delta,
  }, messageState, { fromNativeFamily: true })
}

export function handleNativeTextEndedEvent(
  win: BrowserWindow,
  dispatchRuntimeEvent: DispatchRuntimeEvent,
  properties: Record<string, unknown> | null | undefined,
  messageState: SessionScopedMessageState,
  cachedModelId: string,
  kind: 'text' | 'reasoning',
) {
  const { sessionID, messageID } = nativeMessageEventFields(properties)
  const partID = readString(readRecordValue(properties, kind === 'text' ? 'textID' : 'reasoningID'))
  const content = readString(readRecordValue(properties, 'text'))
  if (!sessionID || !messageID || !content) return
  setMessageRole(messageState, sessionID, messageID, 'assistant')
  markNativeMessageOwned(messageState, sessionID, messageID)
  handleMessagePartUpdatedEvent(win, dispatchRuntimeEvent, {
    sessionID,
    messageID,
    part: {
      type: kind,
      id: partID,
      sessionID,
      messageID,
      text: content,
    },
  }, messageState, cachedModelId, { fromNativeFamily: true })
}

function nativeToolKey(sessionID: string, callID: string) {
  return `${sessionID}\0${callID}`
}

export function handleNativeToolEvent(
  win: BrowserWindow,
  dispatchRuntimeEvent: DispatchRuntimeEvent,
  type: string,
  properties: Record<string, unknown> | null | undefined,
  messageState: SessionScopedMessageState,
  cachedModelId: string,
) {
  const { sessionID, messageID } = nativeMessageEventFields(properties)
  const callID = readString(readRecordValue(properties, 'callID'))
  if (!sessionID || !messageID || !callID) return
  markNativeMessageOwned(messageState, sessionID, messageID)
  markNativeToolOwned(messageState, sessionID, callID)
  const key = nativeToolKey(sessionID, callID)
  const previous = messageState.nativeToolPartsByKey.get(key) || {}
  const previousState = asRecord(readRecordValue(previous, 'state'))
  const provider = asRecord(readRecordValue(properties, 'provider'))
  const providerMetadata = asRecord(readRecordValue(provider, 'metadata'))
  const structured = readRecordValue(properties, 'structured')
  const content = readRecordValue(properties, 'content')
  const result = readRecordValue(properties, 'result')
  const attachments = normalizeToolAttachments(readRecordValue(previousState, 'attachments'), content)
  const outputPaths = normalizeToolOutputPaths(
    readRecordValue(previousState, 'outputPaths'),
    readRecordValue(properties, 'outputPaths'),
  )
  const output = result !== undefined
    ? result
    : content !== undefined
      ? content
      : structured
  const next: Record<string, unknown> = {
    ...previous,
    type: 'tool',
    id: callID,
    callID,
    sessionID,
    messageID,
    tool: readString(readRecordValue(properties, 'tool'))
      || readString(readRecordValue(previous, 'tool'))
      || 'tool',
    state: {
      ...previousState,
      ...(readRecordValue(properties, 'input') && typeof readRecordValue(properties, 'input') === 'object'
        ? { input: readRecordValue(properties, 'input') }
        : {}),
      ...(output !== undefined ? { output } : {}),
      ...(result !== undefined ? { result } : {}),
      ...(readRecordValue(properties, 'error') !== undefined ? { error: readRecordValue(properties, 'error') } : {}),
      metadata: {
        ...asRecord(readRecordValue(previousState, 'metadata')),
        ...asRecord(structured),
        ...providerMetadata,
      },
      attachments,
      outputPaths,
      status: type === 'session.next.tool.success'
        ? 'completed'
        : type === 'session.next.tool.failed'
          ? 'error'
          : 'running',
    },
  }
  messageState.nativeToolPartsByKey.delete(key)
  if (type !== 'session.next.tool.success' && type !== 'session.next.tool.failed') {
    messageState.nativeToolPartsByKey.set(key, next)
    while (messageState.nativeToolPartsByKey.size > MAX_TOTAL_MESSAGE_ROLES) {
      const oldest = messageState.nativeToolPartsByKey.keys().next().value
      if (typeof oldest !== 'string') break
      messageState.nativeToolPartsByKey.delete(oldest)
    }
  }
  setMessageRole(messageState, sessionID, messageID, 'assistant')
  handleMessagePartUpdatedEvent(win, dispatchRuntimeEvent, {
    sessionID,
    messageID,
    part: next,
  }, messageState, cachedModelId, { fromNativeFamily: true })
}

export function handleNativeStepEndedEvent(
  win: BrowserWindow,
  dispatchRuntimeEvent: DispatchRuntimeEvent,
  properties: Record<string, unknown> | null | undefined,
  messageState: SessionScopedMessageState,
  cachedModelId: string,
) {
  const { sessionID, messageID } = nativeMessageEventFields(properties)
  if (!sessionID || !messageID) return
  setMessageRole(messageState, sessionID, messageID, 'assistant')
  markNativeMessageOwned(messageState, sessionID, messageID)
  handleMessagePartUpdatedEvent(win, dispatchRuntimeEvent, {
    sessionID,
    messageID,
    part: {
      type: 'step-finish',
      id: `${messageID}:step-finish`,
      sessionID,
      messageID,
      cost: readRecordValue(properties, 'cost'),
      tokens: readRecordValue(properties, 'tokens'),
      reason: readRecordValue(properties, 'finish'),
    },
  }, messageState, cachedModelId, { fromNativeFamily: true })
}

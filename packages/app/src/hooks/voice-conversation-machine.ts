/**
 * Pure state machine for PTT-gated private voice conversation (JOE-1107).
 *
 * Idle → Listening → FinalizingSTT → Prompting → Streaming → Speaking → Idle
 *
 * Side effects (IPC, prompt, abort, TTS) are owned by the driver; this module
 * only decides the next phase and which effect intents to run.
 */

export type VoiceConversationPhase =
  | 'idle'
  | 'listening'
  | 'finalizing'
  | 'prompting'
  | 'streaming'
  | 'speaking'
  | 'error'

export type VoiceConversationEvent =
  | { type: 'START_LISTEN' }
  | { type: 'STOP_LISTEN' }
  | { type: 'CANCEL' }
  | { type: 'BARGE_IN' }
  | { type: 'STT_FINAL'; text: string }
  | { type: 'STT_ERROR'; message: string }
  | { type: 'PROMPT_SENT' }
  | { type: 'PROMPT_ERROR'; message: string }
  | { type: 'STREAM_DONE'; text: string }
  | { type: 'SPEAK_DONE' }
  | { type: 'SPEAK_ERROR'; message: string }
  | { type: 'RESET' }

export type VoiceConversationEffect =
  | { type: 'start_listen' }
  | { type: 'stop_listen' }
  | { type: 'cancel_listen' }
  | { type: 'prompt'; text: string }
  | { type: 'abort_generation' }
  | { type: 'speak'; text: string }
  | { type: 'cancel_speak' }
  | { type: 'stop_read_aloud' }

export type VoiceConversationState = {
  phase: VoiceConversationPhase
  lastError: string | null
  /** Last non-empty STT final in this turn (for diagnostics). */
  lastUserText: string | null
  /** Last assistant reply text spoken or ready to speak. */
  lastAssistantText: string | null
}

export type VoiceConversationTransition = {
  state: VoiceConversationState
  effects: VoiceConversationEffect[]
}

export function createInitialVoiceConversationState(): VoiceConversationState {
  return {
    phase: 'idle',
    lastError: null,
    lastUserText: null,
    lastAssistantText: null,
  }
}

function withPhase(
  state: VoiceConversationState,
  phase: VoiceConversationPhase,
  patch: Partial<VoiceConversationState> = {},
): VoiceConversationState {
  return { ...state, phase, ...patch }
}

/**
 * Pure reducer. Unknown / illegal transitions leave state unchanged (no effects).
 */
export function reduceVoiceConversation(
  state: VoiceConversationState,
  event: VoiceConversationEvent,
): VoiceConversationTransition {
  switch (event.type) {
    case 'RESET':
      return { state: createInitialVoiceConversationState(), effects: [{ type: 'cancel_speak' }, { type: 'cancel_listen' }] }

    case 'START_LISTEN': {
      if (state.phase === 'listening') {
        return { state, effects: [] }
      }
      // Barge-in from speaking/streaming/prompting: stop TTS + abort gen, then listen.
      if (state.phase === 'speaking' || state.phase === 'streaming' || state.phase === 'prompting') {
        return {
          state: withPhase(state, 'listening', { lastError: null }),
          effects: [
            { type: 'stop_read_aloud' },
            { type: 'cancel_speak' },
            { type: 'abort_generation' },
            { type: 'start_listen' },
          ],
        }
      }
      if (state.phase === 'idle' || state.phase === 'error' || state.phase === 'finalizing') {
        return {
          state: withPhase(state, 'listening', { lastError: null, lastUserText: null, lastAssistantText: null }),
          effects: [{ type: 'stop_read_aloud' }, { type: 'cancel_speak' }, { type: 'start_listen' }],
        }
      }
      return { state, effects: [] }
    }

    case 'STOP_LISTEN': {
      if (state.phase !== 'listening') return { state, effects: [] }
      return {
        state: withPhase(state, 'finalizing'),
        effects: [{ type: 'stop_listen' }],
      }
    }

    case 'STT_FINAL': {
      if (state.phase !== 'finalizing' && state.phase !== 'listening') {
        return { state, effects: [] }
      }
      const text = event.text.trim()
      if (!text) {
        return {
          state: withPhase(state, 'idle', { lastUserText: null }),
          effects: [],
        }
      }
      return {
        state: withPhase(state, 'prompting', { lastUserText: text, lastError: null }),
        effects: [{ type: 'prompt', text }],
      }
    }

    case 'STT_ERROR': {
      if (state.phase !== 'finalizing' && state.phase !== 'listening') {
        return { state, effects: [] }
      }
      return {
        state: withPhase(state, 'error', { lastError: event.message }),
        effects: [],
      }
    }

    case 'PROMPT_SENT': {
      if (state.phase !== 'prompting') return { state, effects: [] }
      return {
        state: withPhase(state, 'streaming'),
        effects: [],
      }
    }

    case 'PROMPT_ERROR': {
      if (state.phase !== 'prompting') return { state, effects: [] }
      return {
        state: withPhase(state, 'error', { lastError: event.message }),
        effects: [],
      }
    }

    case 'STREAM_DONE': {
      if (state.phase !== 'streaming' && state.phase !== 'prompting') {
        return { state, effects: [] }
      }
      const text = event.text.trim()
      if (!text) {
        return {
          state: withPhase(state, 'idle', { lastAssistantText: null }),
          effects: [],
        }
      }
      return {
        state: withPhase(state, 'speaking', { lastAssistantText: text, lastError: null }),
        effects: [{ type: 'speak', text }],
      }
    }

    case 'SPEAK_DONE': {
      if (state.phase !== 'speaking') return { state, effects: [] }
      return {
        state: withPhase(state, 'idle'),
        effects: [],
      }
    }

    case 'SPEAK_ERROR': {
      if (state.phase !== 'speaking') return { state, effects: [] }
      return {
        state: withPhase(state, 'error', { lastError: event.message }),
        effects: [],
      }
    }

    case 'CANCEL':
    case 'BARGE_IN': {
      if (state.phase === 'idle') return { state, effects: [] }
      const effects: VoiceConversationEffect[] = [
        { type: 'stop_read_aloud' },
        { type: 'cancel_speak' },
        { type: 'cancel_listen' },
      ]
      if (state.phase === 'prompting' || state.phase === 'streaming') {
        effects.push({ type: 'abort_generation' })
      }
      // BARGE_IN from non-listening starts a new listen after teardown.
      if (event.type === 'BARGE_IN' && state.phase !== 'listening') {
        return {
          state: withPhase(state, 'listening', { lastError: null }),
          effects: [...effects, { type: 'start_listen' }],
        }
      }
      return {
        state: withPhase(state, 'idle', { lastError: null }),
        effects,
      }
    }

    default:
      return { state, effects: [] }
  }
}

/** Map machine phase to short UI chrome label. */
export function voiceConversationStatusLabel(phase: VoiceConversationPhase): string | null {
  switch (phase) {
    case 'listening':
      return 'Listening…'
    case 'finalizing':
      return 'Transcribing…'
    case 'prompting':
    case 'streaming':
      return 'Thinking…'
    case 'speaking':
      return 'Speaking…'
    case 'error':
      return 'Voice error'
    default:
      return null
  }
}

/** Compact chrome phase for mic button styling. */
export function voiceConversationChromePhase(
  phase: VoiceConversationPhase,
): 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error' {
  if (phase === 'listening') return 'listening'
  if (phase === 'finalizing') return 'transcribing'
  if (phase === 'prompting' || phase === 'streaming') return 'thinking'
  if (phase === 'speaking') return 'speaking'
  if (phase === 'error') return 'error'
  return 'idle'
}

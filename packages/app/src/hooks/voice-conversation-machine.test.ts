import { describe, expect, it } from 'vitest'
import {
  createInitialVoiceConversationState,
  reduceVoiceConversation,
  voiceConversationChromePhase,
  voiceConversationStatusLabel,
  type VoiceConversationState,
} from './voice-conversation-machine'

function apply(
  state: VoiceConversationState,
  ...events: Parameters<typeof reduceVoiceConversation>[1][]
) {
  let current = state
  const allEffects: ReturnType<typeof reduceVoiceConversation>['effects'] = []
  for (const event of events) {
    const next = reduceVoiceConversation(current, event)
    current = next.state
    allEffects.push(...next.effects)
  }
  return { state: current, effects: allEffects }
}

describe('voice conversation machine', () => {
  it('runs the happy path idle → listen → finalize → prompt → stream → speak → idle', () => {
    let state = createInitialVoiceConversationState()
    let step = reduceVoiceConversation(state, { type: 'START_LISTEN' })
    expect(step.state.phase).toBe('listening')
    expect(step.effects.map((e) => e.type)).toEqual(
      expect.arrayContaining(['start_listen', 'stop_read_aloud', 'cancel_speak']),
    )

    step = reduceVoiceConversation(step.state, { type: 'STOP_LISTEN' })
    expect(step.state.phase).toBe('finalizing')
    expect(step.effects).toEqual([{ type: 'stop_listen' }])

    step = reduceVoiceConversation(step.state, { type: 'STT_FINAL', text: '  hello agent  ' })
    expect(step.state.phase).toBe('prompting')
    expect(step.state.lastUserText).toBe('hello agent')
    expect(step.effects).toEqual([{ type: 'prompt', text: 'hello agent' }])

    step = reduceVoiceConversation(step.state, { type: 'PROMPT_SENT' })
    expect(step.state.phase).toBe('streaming')

    step = reduceVoiceConversation(step.state, { type: 'STREAM_DONE', text: 'Hi there' })
    expect(step.state.phase).toBe('speaking')
    expect(step.effects).toEqual([{ type: 'speak', text: 'Hi there' }])

    step = reduceVoiceConversation(step.state, { type: 'SPEAK_DONE' })
    expect(step.state.phase).toBe('idle')
  })

  it('returns to idle on empty STT final without prompting', () => {
    const { state, effects } = apply(
      createInitialVoiceConversationState(),
      { type: 'START_LISTEN' },
      { type: 'STOP_LISTEN' },
      { type: 'STT_FINAL', text: '   ' },
    )
    expect(state.phase).toBe('idle')
    expect(effects.filter((e) => e.type === 'prompt')).toHaveLength(0)
  })

  it('cancels listen, TTS, and generation from streaming', () => {
    let state = createInitialVoiceConversationState()
    state = reduceVoiceConversation(state, { type: 'START_LISTEN' }).state
    state = reduceVoiceConversation(state, { type: 'STOP_LISTEN' }).state
    state = reduceVoiceConversation(state, { type: 'STT_FINAL', text: 'go' }).state
    state = reduceVoiceConversation(state, { type: 'PROMPT_SENT' }).state
    expect(state.phase).toBe('streaming')

    const cancel = reduceVoiceConversation(state, { type: 'CANCEL' })
    expect(cancel.state.phase).toBe('idle')
    expect(cancel.effects.map((e) => e.type)).toEqual(
      expect.arrayContaining(['cancel_speak', 'cancel_listen', 'abort_generation']),
    )
  })

  it('barge-in from speaking stops TTS and starts listening', () => {
    let state = createInitialVoiceConversationState()
    state = reduceVoiceConversation(state, { type: 'START_LISTEN' }).state
    state = reduceVoiceConversation(state, { type: 'STOP_LISTEN' }).state
    state = reduceVoiceConversation(state, { type: 'STT_FINAL', text: 'hi' }).state
    state = reduceVoiceConversation(state, { type: 'PROMPT_SENT' }).state
    state = reduceVoiceConversation(state, { type: 'STREAM_DONE', text: 'reply' }).state
    expect(state.phase).toBe('speaking')

    const barge = reduceVoiceConversation(state, { type: 'BARGE_IN' })
    expect(barge.state.phase).toBe('listening')
    expect(barge.effects.map((e) => e.type)).toEqual(
      expect.arrayContaining(['cancel_speak', 'start_listen']),
    )
  })

  it('records STT and prompt errors', () => {
    let state = createInitialVoiceConversationState()
    state = reduceVoiceConversation(state, { type: 'START_LISTEN' }).state
    state = reduceVoiceConversation(state, { type: 'STOP_LISTEN' }).state
    let next = reduceVoiceConversation(state, { type: 'STT_ERROR', message: 'mic failed' })
    expect(next.state.phase).toBe('error')
    expect(next.state.lastError).toBe('mic failed')

    state = createInitialVoiceConversationState()
    state = reduceVoiceConversation(state, { type: 'START_LISTEN' }).state
    state = reduceVoiceConversation(state, { type: 'STOP_LISTEN' }).state
    state = reduceVoiceConversation(state, { type: 'STT_FINAL', text: 'x' }).state
    next = reduceVoiceConversation(state, { type: 'PROMPT_ERROR', message: 'prompt failed' })
    expect(next.state.phase).toBe('error')
    expect(next.state.lastError).toBe('prompt failed')
  })

  it('maps chrome labels for UI', () => {
    expect(voiceConversationStatusLabel('listening')).toMatch(/Listening/)
    expect(voiceConversationStatusLabel('streaming')).toMatch(/Thinking/)
    expect(voiceConversationStatusLabel('speaking')).toMatch(/Speaking/)
    expect(voiceConversationChromePhase('streaming')).toBe('thinking')
    expect(voiceConversationChromePhase('finalizing')).toBe('transcribing')
  })
})

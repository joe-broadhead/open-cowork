import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { VoicePttButton } from './VoicePttButton'
import type { VoicePttController } from '../../hooks/useVoicePtt'
import type { VoiceConversationController } from '../../hooks/useVoiceConversation'

function baseVoice(overrides: Partial<VoicePttController> = {}): VoicePttController {
  return {
    visible: true,
    enabled: true,
    disabledReason: null,
    phase: 'idle',
    statusLabel: null,
    isActive: false,
    toggle: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    ...overrides,
  }
}

function baseConversation(
  overrides: Partial<VoiceConversationController> = {},
): VoiceConversationController {
  return {
    visible: true,
    enabled: true,
    disabledReason: null,
    phase: 'idle',
    chromePhase: 'idle',
    statusLabel: null,
    isActive: false,
    conversationMode: false,
    setConversationMode: vi.fn(),
    continuousVad: false,
    setContinuousVad: vi.fn(),
    privacyListening: false,
    toggle: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('VoicePttButton a11y (JOE-1112)', () => {
  it('exposes aria-pressed and status live region while listening', () => {
    render(
      <VoicePttButton
        voice={baseVoice({ phase: 'listening', statusLabel: 'Listening…', isActive: true })}
      />,
    )
    const mic = screen.getByTestId('voice-ptt-button')
    expect(mic).toHaveAttribute('aria-pressed', 'true')
    const status = screen.getByTestId('voice-status-label')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveTextContent(/Listening/)
  })

  it('shows disabled reason as a status region (not a mute one-liner)', () => {
    render(
      <VoicePttButton
        voice={baseVoice({
          enabled: false,
          disabledReason: 'Microphone permission is denied. Enable it in system settings.',
        })}
      />,
    )
    const banner = screen.getByTestId('voice-disabled-reason')
    expect(banner).toHaveAttribute('role', 'status')
    expect(banner).toHaveTextContent(/Microphone permission/)
    expect(screen.getByTestId('voice-ptt-button')).toBeDisabled()
  })

  it('toggles conversation mode and continuous VAD with aria-pressed', () => {
    const setConversationMode = vi.fn()
    const setContinuousVad = vi.fn()
    render(
      <VoicePttButton
        voice={baseVoice()}
        conversation={baseConversation({
          conversationMode: true,
          setConversationMode,
          continuousVad: false,
          setContinuousVad,
          chromePhase: 'idle',
        })}
      />,
    )
    fireEvent.click(screen.getByTestId('voice-conversation-mode'))
    expect(setConversationMode).toHaveBeenCalledWith(false)
    fireEvent.click(screen.getByTestId('voice-continuous-vad'))
    expect(setContinuousVad).toHaveBeenCalledWith(true)
  })

  it('hides control when voice is not visible', () => {
    render(<VoicePttButton voice={baseVoice({ visible: false })} />)
    expect(screen.queryByTestId('voice-ptt-button')).toBeNull()
  })

  it('marks busy phases with aria-busy via loading spinner on the mic control', () => {
    render(
      <VoicePttButton
        voice={baseVoice()}
        conversation={baseConversation({
          conversationMode: true,
          chromePhase: 'thinking',
          phase: 'streaming',
          statusLabel: 'Thinking…',
          isActive: true,
          enabled: true,
        })}
      />,
    )
    // IconButton sets aria-busy when loading=true (transcribing/thinking).
    expect(screen.getByTestId('voice-ptt-button')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByTestId('voice-status-label')).toHaveTextContent(/Thinking/)
  })
})

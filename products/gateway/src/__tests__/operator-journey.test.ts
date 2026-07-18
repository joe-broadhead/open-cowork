import { describe, expect, it } from 'vitest'
import {
  channelControlOperatorJourneys,
  openCodeSessionLinkJourney,
} from '../operator-journey.js'

describe('operator journey contract', () => {
  it('turns unavailable OpenCode Web links into recoverable operator journeys', () => {
    const journey = openCodeSessionLinkJourney({
      sessionId: 'ses_missing',
      webStatus: 'unavailable',
      webStatusReason: 'session not found in OpenCode API',
      webRecoveryHint: 'Use /new, /switch, or /project bind --rebind.',
      tuiCommand: 'opencode --session ses_missing',
      missionControlUrl: 'http://127.0.0.1:4097/dashboard',
      sessionEvidenceUrl: 'http://127.0.0.1:4097/opencode/sessions/ses_missing',
    })

    expect(journey).toMatchObject({
      schemaVersion: 1,
      surface: 'opencode_web_tui',
      waitOwner: 'operator',
      permissionState: 'not_required',
      channelCapability: 'fallback',
      proofState: 'missing',
      recoveryPath: {
        state: 'recoverable',
        safeNextAction: 'Use /new, /switch, or /project bind --rebind.',
        fallbackSurfaces: ['cli_mcp', 'mission_control'],
      },
      releaseClaim: 'local_operator_journey_truth_only',
    })
    expect(journey.limitations.join(' ')).toContain('No stale Web deep link')
    expect(journey.limitations.join(' ')).toContain('OpenCode owns Session state')
  })

  it('classifies provider native controls with supported partial fallback blocked and deferred vocabulary', () => {
    const rows = channelControlOperatorJourneys([
      {
        provider: 'telegram',
        typedCommand: 'supported',
        slash: 'supported',
        argumentAutocomplete: 'deferred',
        nativeAction: 'partial',
        presence: 'supported',
        fallback: ['copy_command'],
        evidence: ['telegram_set_my_commands', 'telegram_send_chat_action'],
        summary: 'Telegram native controls are available for trusted inbound work.',
      },
      {
        provider: 'whatsapp',
        typedCommand: 'supported',
        slash: 'not_applicable',
        argumentAutocomplete: 'not_applicable',
        nativeAction: 'partial',
        presence: 'deferred',
        fallback: ['typed_command'],
        evidence: ['renderer_fallback', 'adapter_contract'],
        summary: 'WhatsApp native slash and typing are not live-proven.',
      },
      {
        provider: 'discord',
        typedCommand: 'supported',
        slash: 'deferred',
        argumentAutocomplete: 'deferred',
        nativeAction: 'deferred',
        presence: 'deferred',
        fallback: ['typed_command'],
        evidence: ['renderer_fallback'],
        summary: 'Discord remains alpha metadata.',
      },
    ])

    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'channel:telegram:slash', channelCapability: 'supported', proofState: 'passed' }),
      expect.objectContaining({ id: 'channel:telegram:argument_autocomplete', channelCapability: 'deferred', proofState: 'deferred' }),
      expect.objectContaining({ id: 'channel:telegram:native_action', channelCapability: 'partial', proofState: 'partial' }),
      expect.objectContaining({ id: 'channel:whatsapp:slash', channelCapability: 'fallback', proofState: 'partial' }),
      expect.objectContaining({ id: 'channel:whatsapp:argument_autocomplete', channelCapability: 'fallback', proofState: 'partial' }),
      expect.objectContaining({ id: 'channel:whatsapp:presence', channelCapability: 'deferred', proofState: 'deferred', waitOwner: 'provider' }),
      expect.objectContaining({ id: 'channel:discord:slash', channelCapability: 'deferred', proofState: 'deferred' }),
    ]))
  })
})

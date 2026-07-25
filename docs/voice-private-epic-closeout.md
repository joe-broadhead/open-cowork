# Private realtime voice — epic close-out (JOE-1114)

Parent epic: [JOE-1096](https://linear.app/joe-broadhead/issue/JOE-1096).

## Children status

| ID | Title | Status |
| --- | --- | --- |
| JOE-1099 | V0.1 Spec + claim boundary | Done |
| JOE-1100 | V0.2 Feature flag + support matrix | Done |
| JOE-1098 | V0.3 OS permissions | Done |
| JOE-1097 | V1.1 Voice host PCM + IPC | Done |
| JOE-1101 | V1.2 Aurum STT local_only | Done |
| JOE-1102 | V1.3 Partials | Done |
| JOE-1105 | V2.1 Chat/Home PTT UI | Done |
| JOE-1110 | V2.2 Hotkey | Done |
| JOE-1108 | V3.1 Local TTS sibling | Done |
| JOE-1103 | V3.2 Read-aloud | Done |
| JOE-1107 | V4.1 Conversation controller | Done |
| JOE-1104 | V4.2 VAD continuous + barge-in | Done |
| JOE-1109 | V5.1 Assets first-run | Done |
| JOE-1106 | V5.2 Packaging | Done (honest residual documented) |
| JOE-1111 | V6.1 Security audit | Done |
| JOE-1112 | V6.3 Accessibility | Done |
| JOE-1113 | V6.2 Dogfood + claim freeze | Done |
| JOE-1114 | V6.4 Epic close-out | Done (this doc) |

**P0 open children without Waive:** none.

## Residual risk register

| ID | Severity | Risk | Mitigation / Waive |
| --- | --- | --- | --- |
| R-VOICE-01 | P2 | Partial/final IPC carries transcript text | Product requirement; no audio on IPC; no free-text adoption telemetry |
| R-VOICE-02 | P2 | Temp WAV for Aurum CLI | OS temp + `rmSync` in finally |
| R-VOICE-03 | P2 | OS TTS temp AIFF | Local host; cancel best-effort |
| R-VOICE-04 | P2 | Opt-in model download env | Default off; files only |
| R-VOICE-05 | P3 | `getLastTranscript` host memory | Not on preload/IPC |
| R-VOICE-06 | P2 | Aurum/ffmpeg not pre-bundled in CI packages | Fail-closed + packaging README; macOS supported when tools present |
| R-VOICE-07 | P2 | Windows/Linux TTS OS backends residual | Best-effort claim; status unavailable when tools missing |
| R-VOICE-08 | P3 | Energy VAD is RMS not neural | Documented; opt-in continuous only |

No P0 residual without Waive.

## Demo evidence template

```text
Epic: JOE-1096 Private realtime voice
SHA: 48b3df4396a933c0809f5d77d557849d5f166458 (pre-merge; update after merge)
Platform: macOS arm64
features.voice: true
Scenarios:
  - PTT dictation: pass/fail
  - Read-aloud: pass/fail
  - Conversation + optional continuous: pass/fail
Aurum model: tiny-q5_1 cached: yes/no
Notes:
```

Automated evidence (CI): voice unit/security/packaging tests on PRs; ADR + dogfood runbook in tree.

## Claim freeze pointer

- Runbook: [voice-private-dogfood.md](./runbooks/voice-private-dogfood.md)
- ADR: [private-realtime-voice.md](./adr/private-realtime-voice.md)
- Purity register: [product-purity-register.md](./product-purity-register.md)
- Release checklist purity gate includes voice claim check

## Milestone

Milestone **Private Realtime Voice — STT + TTS (2026-07)** children complete; mark epic Done when Linear children reflect this table.

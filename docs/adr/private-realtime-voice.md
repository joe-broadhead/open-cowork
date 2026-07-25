---
title: ADR — Private realtime voice (Desktop Local)
description: On-machine STT/TTS for Open Cowork Desktop Local; Aurum STT, sibling TTS, voice host outside renderer.
---

# ADR: Private realtime voice (Desktop Local)

| Field | Value |
| --- | --- |
| Status | **Accepted** |
| Date | 2026-07-24 |
| Linear | [JOE-1096](https://linear.app/joe-broadhead/issue/JOE-1096) epic; V0 [JOE-1099](https://linear.app/joe-broadhead/issue/JOE-1099) |
| Milestone | Private Realtime Voice |

## Context

Operators want **push-to-talk / conversational voice** against local OpenCode sessions without sending microphone audio to cloud STT/TTS vendors by default.

Sibling work:

- **Aurum** — on-device speech-to-text (`aurum-stt` / whisper.cpp; PCM-first library API). Optional remote paths exist but are never the default.
- **ZephyrFlow** — macOS menu-bar dictation product (Whisper, Local Only). Reference UX for PTT; **not** a TTS engine and not the Open Cowork voice host.

Open Cowork already removed fake Settings “voice replies” teasers (product purity JOE-1031). Voice must not reappear as a half-wired toggle.

## Decision

### 1. Product surface

| Rule | Decision |
| --- | --- |
| Default authority | **Desktop Local only** |
| Cloud Desktop / Cloud Web | **Blocked** — `voice.*` support APIs are `not_supported` |
| Gateway / paired | **Blocked** until a future ADR |
| Feature flag | `features.voice` — **secondary**, default **off** (progressive disclosure) |
| Public claims | No “private voice shipping” until V2 PTT UI + local STT path are real |

### 2. Engine split

| Role | Owner | Notes |
| --- | --- | --- |
| **STT** | **Aurum** (`local_only` / on-device) | PCM in → text out; no API key by default |
| **TTS** | **Sibling / separate engine** | **Not Aurum**. MVP = **OS system speech** (`system_os`, macOS `say`+`afplay`); Piper/neural sidecar deferred |
| Orchestration | Open Cowork **voice host** (Electron main / native side) | Outside Chromium renderer |

### 3. Architecture boundary

```text
Renderer (UI only)
  │  IPC: voice:status | voice:session:* | voice:tts:* | voice:partial | voice:final
  ▼
Voice host (main / native — never Node in renderer)
  │  mic capture (OS APIs)
  │  STT via Aurum local_only
  │  TTS via sibling engine (OS system speech MVP)
  ▼
OpenCode session prompt / stream (existing session path)
```

Rules:

1. **No raw audio bytes on the renderer IPC path** by default. Prefer partial/final **text** and host-owned playback. Status may include capture **frame counts** only.
2. Chromium `getUserMedia` / Electron session `media` for the **Studio renderer stays denied** unless a future ADR chooses an explicit renderer capture mode.
3. OS microphone permission is owned by the **voice host**, not by ad-hoc Settings toggles.
4. Cloud Web must never request mic for Open Cowork Studio (support matrix + browser matrix).
5. **Capture (JOE-1097):** host accumulates mono **16 kHz f32** PCM in main (`VoicePcmBuffer`). Default backend is **ffmpeg** when available; tests inject `FakeVoiceCapture`. PCM is cleared on stop/cancel and is never sent to the renderer.
6. **STT (JOE-1101):** on release/stop, host runs **Aurum** with **local provider only** (`--provider local`, cleanup via rules). Default model `tiny-q5_1`. **local_only** fail-closed unless `OPEN_COWORK_AURUM_ALLOW_DOWNLOAD=1`. OpenRouter/cloud ASR is never on the default path. Final text is emitted as a `voice:event` final payload (text only).
7. **PTT UI (JOE-1105):** Chat and Home composers show a mic control when `features.voice` is on **and** the workspace support matrix allows `voice.capture` + `voice.stt` (Desktop Local). **Click-to-toggle** is the shipped interaction (start → Listening → click again → Transcribing → inject text into the composer). Control is hidden on Cloud Web / unsupported authorities.
8. **Partials during PTT (JOE-1102):** While listening, the host runs a **PartialClock** (min ~1s audio, ~15s rolling window, ~1.2s interval, RMS energy gate) and emits `voice:event` **partial** payloads (text only). This is **not** a continuous Whisper stream — the host decides when to call STT. The composer snapshots a **baseline** at PTT start; partials/finals replace the dictation segment after the baseline (cancel/error restores baseline).
9. **PTT hotkey (JOE-1110):** Default accelerator `CmdOrCtrl+Shift+Space` (Edit menu “Toggle Voice Dictation”). Scope is **app-focused** only — not OS-wide Accessibility paste into other apps. Settings → Privacy shows a configurable Electron accelerator when `features.voice` is on; menu bar uses the default until process restart; in-app key matching uses the saved value after Save. Avoid colliding with the command palette (`CmdOrCtrl+Shift+P`).
10. **Local TTS (JOE-1108):** Sibling of Aurum STT. **Decision:** MVP uses **OS system voices** (macOS `say` synthesize to temp AIFF + `afplay` playback). **Not** Aurum, **not** cloud TTS, **not** Chromium `speechSynthesis` in the renderer. Host owns synthesize + playback; IPC carries **text only** (`voice:tts:speak` / `cancel` / `voices`). Linux/Windows OS backends and Piper/neural packaging are explicit follow-ups (no download on default path). Claim boundary: “local OS speech when available” — not “neural private TTS GA”.
11. **Read-aloud (JOE-1103):** Per-message **Read aloud** on completed assistant bubbles when `features.voice` + `voice.tts` authority + host TTS ready. **Default off** (no auto-read of streaming tokens). Streaming strategy: **wait for complete message** only (live placeholders have no actions). Stop cancels host playback immediately; optional skip drains the next queued item. Starting PTT calls `stopReadAloud` (barge-in prep). Markdown is stripped to plain text before speak.

### 4. Workspace support APIs

| API | Desktop Local | Cloud / browser / remote |
| --- | --- | --- |
| `voice.capture` | supported (authority) | `not_supported` |
| `voice.stt` | supported (authority) | `not_supported` |
| `voice.tts` | supported (authority) | `not_supported` |
| `voice.conversation` | supported (authority) | `not_supported` |

“Supported” means **this authority may host voice**, not that every UI control is complete. Runtime readiness is reported via `voice:status` (`ready` / `deferred` / `unavailable`). UI stays behind `features.voice`.

### 5. Progressive disclosure

- Omit or set `features.voice: false` in public default config.
- Soft enablement warning via `desktopFeatureEnablementWarnings` (local-only, Aurum STT, sibling TTS, host not renderer).
- Do not market voice until release checklist evidence is green.

## Non-goals (this milestone)

- Cloud / multi-tenant voice
- Using Aurum as TTS
- Shipping ZephyrFlow inside Open Cowork
- Renderer-owned continuous listening without PTT policy
- Replacing chat text input as the only interaction mode

## Consequences

- Shared package grows `voice` IPC types and `voice.*` workspace support keys.
- Electron permission guards stay fail-closed for renderer media; docs state host ownership.
- Residual purity risk for incomplete secondaries remains soft-warn only (same pattern as other Studio flags).

## Related

- [Progressive disclosure](../progressive-disclosure.md)
- [Product purity register](../product-purity-register.md)
- [Release checklist](../release-checklist.md)
- Aurum: https://github.com/joe-broadhead/aurum
- ZephyrFlow: https://github.com/joe-broadhead/zephyr-flow

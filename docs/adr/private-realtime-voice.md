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
| **TTS** | **Sibling / separate engine** | **Not Aurum**. Aurum is STT-first; do not stretch it into synthesis |
| Orchestration | Open Cowork **voice host** (Electron main / native side) | Outside Chromium renderer |

### 3. Architecture boundary

```text
Renderer (UI only)
  │  IPC: voice:status | voice:session:* | voice:partial | voice:final
  ▼
Voice host (main / native — never Node in renderer)
  │  mic capture (OS APIs)
  │  STT via Aurum local_only
  │  TTS via sibling engine
  ▼
OpenCode session prompt / stream (existing session path)
```

Rules:

1. **No raw audio bytes on the renderer IPC path** by default. Prefer partial/final **text** and host-owned playback.
2. Chromium `getUserMedia` / Electron session `media` for the **Studio renderer stays denied** unless a future ADR chooses an explicit renderer capture mode.
3. OS microphone permission is owned by the **voice host**, not by ad-hoc Settings toggles.
4. Cloud Web must never request mic for Open Cowork Studio (support matrix + browser matrix).

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

# Private voice dogfood runbook (JOE-1113)

Desktop Local only. Feature flag **`features.voice`** default **off**.

## Preconditions

1. Open Cowork Desktop on **macOS** (primary). Windows/Linux are best-effort (see packaging residual).
2. Set in `open-cowork.config.json` (or operator overlay):

```json
{
  "features": {
    "voice": true
  }
}
```

3. Install tools (not pre-bundled in every CI package):
   - **ffmpeg** on `PATH` (or `OPEN_COWORK_FFMPEG_PATH`)
   - **aurum** CLI on `PATH` (or `OPEN_COWORK_AURUM_BIN`), model `tiny-q5_1` cached
   - Optional: drop binaries under packaged `resources/voice/` (see `apps/desktop/resources/voice/README.md`)
4. Grant **microphone** permission when prompted (host-owned, not renderer `getUserMedia`).
5. Workspace must be **Desktop Local** — Cloud Web / paired authorities stay `not_supported`.

## Scenarios

### A. Dictation PTT (JOE-1105 / JOE-1102)

1. Open Chat or Home composer.
2. Confirm mic control visible (`data-testid="voice-ptt-button"`).
3. Click mic → status **Listening…** (live region).
4. Speak a short phrase; click again → **Transcribing…** then text injects into composer.
5. Cancel mid-listen (if exposed) must not send a prompt.
6. Partials may update the dictation segment while holding; final replaces them.

### B. Hotkey (JOE-1110)

1. Focus Open Cowork (app-focused only — not OS-wide paste).
2. Default: `Cmd+Shift+Space` / `Ctrl+Shift+Space`.
3. Settings → Privacy → Private voice shows accelerator when flag on.
4. Avoid collision with command palette (`Cmd/Ctrl+Shift+P`).

### C. Read-aloud (JOE-1103)

1. Complete an assistant message.
2. **Read aloud** on the bubble (when TTS ready).
3. Stop cancels immediately; starting PTT stops read-aloud.

### D. Conversation mode (JOE-1107)

1. Toggle **conversation** (radio icon) on.
2. Mic starts a listen → final → agent prompt → stream → local TTS of reply.
3. Status cycles Listening / Transcribing / Thinking / Speaking.

### E. Continuous VAD + barge-in (JOE-1104)

1. Conversation mode on → toggle **continuous** (activity icon).
2. Privacy red dot while mic armed.
3. After speak, mic re-arms; speak over TTS to barge-in (cancels speech + re-listens).
4. Continuous stays **off** by default; never silent always-on.

### F. Assets offline (JOE-1109)

1. Settings → Privacy → Voice assets.
2. **Refresh status** / **Ensure local model**.
3. Missing model + no download env → clear fail-closed message (no silent network).

### G. Security smoke (JOE-1111)

1. Enable voice, dictate once.
2. Confirm logs show `textChars` / `chars` only — **no** transcript body or PCM in main logs.
3. Cloud Web build: voice controls absent / `not_supported`.

## Evidence to record

| Field | Example |
| --- | --- |
| Git SHA | `git rev-parse HEAD` |
| Platform | macOS arm64 15.x |
| Config | `features.voice=true` |
| Aurum | version + model `tiny-q5_1` present |
| Scenarios | A–E pass / fail notes |
| Residual | Windows TTS, Linux TTS, no bundled model weights |

Paste evidence as a comment on [JOE-1096](https://linear.app/joe-broadhead/issue/JOE-1096).

## Claim freeze (allowed vs forbidden)

### Allowed (when flag on + tools present)

- “Desktop Local private voice (opt-in): on-device STT via Aurum, local OS TTS, PTT and optional conversation.”
- “Audio stays on-machine on the default path (`local_only`).”

### Forbidden

- Cloud / multi-tenant / enterprise voice GA
- Browser / Cloud Web microphone for Studio
- Always-on continuous listen without explicit user enable
- “Ships fully offline in every package” without aurum + model present
- Aurum-as-TTS, cloud STT/TTS as default
- OS-wide Accessibility dictation into other apps (ZephyrFlow territory)

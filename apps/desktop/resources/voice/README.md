# Packaged private voice sidecars (JOE-1106)

This folder is copied into the Desktop app bundle as `resources/voice/`.

## What ships by default

- This README only (no Aurum model weights, no prebuilt aurum-ffi dylib).

## Optional drop-ins (local-only)

Place platform binaries next to this file:

| File | Role |
| --- | --- |
| `aurum` / `aurum.exe` | Aurum CLI for STT (`local_only`) |
| `ffmpeg` / `ffmpeg.exe` | Mic capture pipe (mono 16 kHz f32) |

Resolution order (host):

1. `OPEN_COWORK_AURUM_BIN` / `OPEN_COWORK_FFMPEG_PATH`
2. Packaged path: `{resourcesPath}/voice/aurum` (or `.exe`)
3. System `PATH` (`aurum`, `ffmpeg`)

Models still live under the user data cache (`userData/voice/aurum` or system Aurum cache). See Settings → Privacy → Voice assets.

## Platform support (honest)

| Platform | Capture | STT | TTS | Claim |
| --- | --- | --- | --- | --- |
| macOS arm64/x64 | ffmpeg | aurum CLI + cached model | OS `say`+`afplay` | **Supported** when tools present |
| Windows | ffmpeg dshow | aurum when installed | OS residual | **Best-effort** |
| Linux | ffmpeg pulse | aurum when installed | OS residual | **Best-effort** |

Do not claim “private voice ships fully offline in every package” without models + aurum present.

## Codesign notes

Any Mach-O / PE you drop into this folder must be signed with the same pipeline as other extraResources on release builds, or macOS Gatekeeper / Windows SmartScreen will block spawn. Preview CI packages intentionally omit binaries so missing tools fail closed with a clear status string.

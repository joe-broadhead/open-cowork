/**
 * Read-aloud queue for private local TTS (JOE-1103).
 *
 * Strategy: wait for **complete** assistant messages only (no sentence-flush
 * during streaming). Auto-read is off by default — users opt in per message.
 * Host owns playback; this module only drives text IPC and UI state.
 */
import { isDesktopFeatureEnabled, type DesktopFeatureFlags } from '@open-cowork/shared'

type VoiceReadAloudPhase = 'idle' | 'speaking' | 'error'

export type VoiceReadAloudState = {
  phase: VoiceReadAloudPhase
  messageId: string | null
  queueLength: number
  error: string | null
}

type QueueItem = {
  messageId: string
  text: string
}

type Listener = () => void

const listeners = new Set<Listener>()
let state: VoiceReadAloudState = {
  phase: 'idle',
  messageId: null,
  queueLength: 0,
  error: null,
}
const queue: QueueItem[] = []
let generation = 0
let runPromise: Promise<void> | null = null

function emit() {
  for (const listener of listeners) listener()
}

function setState(patch: Partial<VoiceReadAloudState>) {
  state = { ...state, ...patch, queueLength: queue.length }
  emit()
}

export function getVoiceReadAloudState(): VoiceReadAloudState {
  return state
}

export function subscribeVoiceReadAloud(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Strip markdown-ish markup so OS TTS does not spell out fences and links. */
export function plainTextForTts(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/[*_~|>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function canUseVoiceReadAloud(options: {
  desktop: boolean
  features: DesktopFeatureFlags | undefined
  canVoiceTts: boolean
}): boolean {
  return options.desktop
    && isDesktopFeatureEnabled(options.features, 'voice')
    && options.canVoiceTts
}

async function runQueue(gen: number) {
  while (gen === generation && queue.length > 0) {
    const item = queue.shift()!
    setState({
      phase: 'speaking',
      messageId: item.messageId,
      error: null,
    })
    try {
      if (!window.coworkApi?.voice?.speak) {
        throw new Error('Private voice TTS is unavailable.')
      }
      await window.coworkApi.voice.speak({ text: item.text })
      if (gen !== generation) return
    } catch (error) {
      if (gen !== generation) return
      const message = error instanceof Error ? error.message : String(error)
      queue.length = 0
      setState({
        phase: 'error',
        messageId: null,
        error: message,
      })
      return
    }
  }
  if (gen === generation) {
    setState({
      phase: 'idle',
      messageId: null,
      error: null,
    })
  }
}

function ensureRunner() {
  if (runPromise) return
  const gen = generation
  runPromise = runQueue(gen).finally(() => {
    if (generation === gen) runPromise = null
  })
}

async function cancelHostSpeak() {
  try {
    await window.coworkApi?.voice?.cancelSpeak?.()
  } catch {
    // best-effort
  }
}

/**
 * Play a completed message.
 * Default replaces any current playback (skip-to-this).
 * `append: true` queues behind the current utterance.
 */
export function enqueueReadAloud(
  messageId: string,
  rawText: string,
  options: { append?: boolean } = {},
): void {
  const text = plainTextForTts(rawText)
  if (!text) return

  if (state.messageId === messageId && state.phase === 'speaking') return

  if (options.append && (state.phase === 'speaking' || queue.length > 0)) {
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (queue[i]!.messageId === messageId) queue.splice(i, 1)
    }
    queue.push({ messageId, text })
    setState({ error: null })
    ensureRunner()
    return
  }

  // Replace: abort current host playback and run only this item.
  generation += 1
  queue.length = 0
  queue.push({ messageId, text })
  runPromise = null
  void cancelHostSpeak()
  setState({
    phase: 'speaking',
    messageId: null,
    error: null,
  })
  ensureRunner()
}

/** Stop playback immediately. Used by Stop control and PTT barge-in. */
export async function stopReadAloud(): Promise<void> {
  generation += 1
  queue.length = 0
  runPromise = null
  await cancelHostSpeak()
  setState({
    phase: 'idle',
    messageId: null,
    error: null,
  })
}

/** Skip current utterance and continue with the next queued item if any. */
export async function skipReadAloud(): Promise<void> {
  if (queue.length === 0 && state.phase !== 'speaking') {
    await stopReadAloud()
    return
  }
  generation += 1
  runPromise = null
  await cancelHostSpeak()
  setState({
    phase: queue.length > 0 ? 'speaking' : 'idle',
    messageId: null,
    error: null,
  })
  if (queue.length > 0) ensureRunner()
  else {
    setState({ phase: 'idle', messageId: null, error: null })
  }
}

/** Test helper */
export function resetVoiceReadAloudForTests() {
  generation += 1
  queue.length = 0
  runPromise = null
  state = {
    phase: 'idle',
    messageId: null,
    queueLength: 0,
    error: null,
  }
  emit()
}

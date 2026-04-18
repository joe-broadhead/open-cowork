import { useEffect, useRef, useState } from 'react'
import type { AgentColor } from '@open-cowork/shared'
import { AgentAvatar } from './AgentAvatar'
import { downsampleImageToDataUri } from '../../helpers/image-downsampler'
import { ModalBackdrop } from '../layout/ModalBackdrop'
import { t } from '../../helpers/i18n'

// Popover opened by clicking the avatar on the agent card in edit mode.
// Three actions: upload a new image (via the system file picker →
// downsample → set as data URI), remove the image (falls back to
// gradient initials), and pick from the curated color palette.
//
// Stays small and focused: no cropping UI, no grid of generated
// illustrations, no drag-and-drop. The downsampler center-crops to
// square so any rectangular upload ends up as a clean avatar without
// user intervention.

type Props = {
  name: string
  color: AgentColor
  src: string | null | undefined
  anchorRect: DOMRect | null
  onClose: () => void
  onAvatarChange: (next: string | null) => void
  onColorChange: (next: AgentColor) => void
}

const MAX_AVATAR_EDGE = 192

const COLOR_OPTIONS: Array<{ value: AgentColor; label: string; token: string }> = [
  { value: 'accent', label: 'Blue', token: 'var(--color-accent)' },
  { value: 'success', label: 'Green', token: 'var(--color-green)' },
  { value: 'info', label: 'Sky', token: 'var(--color-info)' },
  { value: 'warning', label: 'Amber', token: 'var(--color-amber)' },
  { value: 'secondary', label: 'Muted', token: 'var(--color-text-secondary)' },
  { value: 'primary', label: 'Neutral', token: 'var(--color-text)' },
]

export function AvatarEditor({
  name,
  color,
  src,
  anchorRect,
  onClose,
  onAvatarChange,
  onColorChange,
}: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])

  // Dismiss on Escape — matches the rest of the app's popovers.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  if (!anchorRect) return null

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 0
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 0
  const WIDTH = 280
  const APPROX_HEIGHT = 320
  const left = Math.min(
    Math.max(12, anchorRect.left),
    viewportWidth - WIDTH - 12,
  )
  const top = Math.min(
    anchorRect.bottom + 8,
    viewportHeight - APPROX_HEIGHT - 12,
  )

  const handleUpload = async () => {
    setBusy(true)
    setError(null)
    try {
      const payload = await window.coworkApi.dialog.selectImage()
      if (!payload) return
      const dataUri = await downsampleImageToDataUri(payload, MAX_AVATAR_EDGE)
      onAvatarChange(dataUri)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load image.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <ModalBackdrop onDismiss={onClose} className="fixed inset-0 z-40" />
      <div
        role="dialog"
        aria-label={t('agentCard.editAvatar', 'Edit agent avatar')}
        className="fixed z-50 rounded-2xl border shadow-2xl overflow-hidden"
        style={{
          width: WIDTH,
          left,
          top,
          background: 'var(--color-base)',
          borderColor: 'var(--color-border)',
        }}
      >
        <div className="p-4 flex items-center gap-3">
          <AgentAvatar name={name} color={color} src={src} size="xl" />
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold text-text">Avatar</div>
            <div className="text-[11px] text-text-muted leading-relaxed">
              Upload an image or keep the gradient default.
            </div>
          </div>
        </div>

        <div className="px-4 pb-3 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => void handleUpload()}
            disabled={busy}
            className="w-full px-3 py-2 rounded-lg text-[12px] font-medium transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-wait"
            style={{
              background: 'var(--color-accent)',
              color: 'var(--color-accent-foreground)',
            }}
          >
            {busy ? 'Processing…' : src ? 'Replace image' : 'Upload image'}
          </button>
          {src && (
            <button
              type="button"
              onClick={() => onAvatarChange(null)}
              className="w-full px-3 py-2 rounded-lg text-[12px] font-medium border border-border-subtle text-text-muted hover:text-text hover:bg-surface-hover transition-colors cursor-pointer"
            >
              Remove image
            </button>
          )}
          {error && (
            <div className="text-[11px]" style={{ color: 'var(--color-red)' }}>{error}</div>
          )}
        </div>

        <div
          className="border-t px-4 py-3"
          style={{ borderColor: 'var(--color-border-subtle)' }}
        >
          <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-2">Color</div>
          <div className="flex items-center gap-2 flex-wrap">
            {COLOR_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => onColorChange(option.value)}
                title={option.label}
                aria-label={t('avatarEditor.setColor', 'Set color to {{label}}', { label: option.label })}
                className="w-7 h-7 rounded-full border cursor-pointer transition-transform hover:scale-110"
                style={{
                  background: `color-mix(in srgb, ${option.token} 34%, transparent)`,
                  borderColor: color === option.value
                    ? 'var(--color-text)'
                    : 'var(--color-border-subtle)',
                  boxShadow: color === option.value
                    ? '0 0 0 2px var(--color-base), 0 0 0 3px var(--color-text)'
                    : 'none',
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </>
  )
}

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writeTextToClipboard } from './clipboard'

describe('writeTextToClipboard', () => {
  beforeEach(() => {
    vi.mocked(window.coworkApi.clipboard.writeText).mockClear()
    const browserWrite = vi.spyOn(navigator.clipboard, 'writeText')
    browserWrite.mockClear()
    browserWrite.mockResolvedValue(undefined)
  })

  it('uses the app clipboard bridge when it succeeds', async () => {
    await expect(writeTextToClipboard('copy me')).resolves.toBe(true)

    expect(window.coworkApi.clipboard.writeText).toHaveBeenCalledWith('copy me')
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
  })

  it('falls back to the browser clipboard when the app bridge returns false', async () => {
    vi.mocked(window.coworkApi.clipboard.writeText).mockResolvedValueOnce(false)

    await expect(writeTextToClipboard('copy me')).resolves.toBe(true)

    expect(window.coworkApi.clipboard.writeText).toHaveBeenCalledWith('copy me')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('copy me')
  })

  it('falls back to the browser clipboard when the app bridge throws', async () => {
    vi.mocked(window.coworkApi.clipboard.writeText).mockRejectedValueOnce(new Error('clipboard denied'))

    await expect(writeTextToClipboard('copy me')).resolves.toBe(true)

    expect(window.coworkApi.clipboard.writeText).toHaveBeenCalledWith('copy me')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('copy me')
  })

  it('returns false when every clipboard path fails', async () => {
    vi.mocked(window.coworkApi.clipboard.writeText).mockResolvedValueOnce(false)
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('clipboard denied'))

    await expect(writeTextToClipboard('copy me')).resolves.toBe(false)
  })
})

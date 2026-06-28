import { afterEach, describe, expect, it, vi } from 'vitest'
import { downsampleImageToDataUri } from './image-downsampler'

const originalImage = globalThis.Image
const originalCreateElement = document.createElement.bind(document)

class LoadedTestImage {
  naturalWidth = 800
  naturalHeight = 400
  onload: (() => void) | null = null
  onerror: (() => void) | null = null

  set src(_value: string) {
    queueMicrotask(() => this.onload?.())
  }
}

function installImageStub() {
  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    writable: true,
    value: LoadedTestImage,
  })
  Object.defineProperty(window, 'Image', {
    configurable: true,
    writable: true,
    value: LoadedTestImage,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    writable: true,
    value: originalImage,
  })
  Object.defineProperty(window, 'Image', {
    configurable: true,
    writable: true,
    value: originalImage,
  })
})

describe('downsampleImageToDataUri', () => {
  it('center-crops to a capped square and chooses jpeg for non-alpha images', async () => {
    installImageStub()
    const drawImage = vi.fn()
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({
        drawImage,
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low',
      })),
      toDataURL: vi.fn(() => 'data:image/jpeg;base64,DOWN'),
    }
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      if (tagName === 'canvas') return canvas as unknown as HTMLCanvasElement
      return originalCreateElement(tagName)
    }) as typeof document.createElement)

    await expect(downsampleImageToDataUri({ mime: 'image/jpeg', base64: 'SOURCE' }, 256))
      .resolves.toBe('data:image/jpeg;base64,DOWN')

    expect(canvas.width).toBe(256)
    expect(canvas.height).toBe(256)
    expect(drawImage).toHaveBeenCalledWith(expect.any(LoadedTestImage), 200, 0, 400, 400, 0, 0, 256, 256)
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.9)
  })

  it('preserves alpha-friendly formats as png and never upscales small images', async () => {
    installImageStub()
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({
        drawImage: vi.fn(),
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low',
      })),
      toDataURL: vi.fn(() => 'data:image/png;base64,DOWN'),
    }
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      if (tagName === 'canvas') return canvas as unknown as HTMLCanvasElement
      return originalCreateElement(tagName)
    }) as typeof document.createElement)

    await expect(downsampleImageToDataUri({ mime: 'image/png', base64: 'SOURCE' }, 1_000))
      .resolves.toBe('data:image/png;base64,DOWN')

    expect(canvas.width).toBe(800)
    expect(canvas.height).toBe(800)
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/png', 0.9)
  })

  it('returns the original data URI when a canvas context is unavailable', async () => {
    installImageStub()
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: vi.fn(() => null),
        } as unknown as HTMLCanvasElement
      }
      return originalCreateElement(tagName)
    }) as typeof document.createElement)

    await expect(downsampleImageToDataUri({ mime: 'image/jpeg', base64: 'SOURCE' }, 256))
      .resolves.toBe('data:image/jpeg;base64,SOURCE')
  })
})

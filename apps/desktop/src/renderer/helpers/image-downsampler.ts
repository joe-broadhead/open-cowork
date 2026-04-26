// Downsamples a base64-encoded image to a capped edge length and
// produces a compact data URI suitable for inlining into an agent's
// sidecar JSON. Keeps the persisted metadata small (target ~60 KB) so
// the sidecar stays comfortable to diff, overlay, and ship between
// project / machine scopes.
//
// Strategy:
// - Decode the source bytes into an HTMLImageElement.
// - Fit into a square canvas of maxEdge × maxEdge, preserving aspect
//   ratio with a center-crop (so rectangular photos become square
//   avatars without distortion).
// - Re-encode as PNG for images with alpha (png / webp / gif) and
//   JPEG otherwise, at quality 0.9.
//
// Pure — no side effects beyond creating temporary DOM elements.

export interface ImagePayload {
  mime: string
  base64: string
}

export async function downsampleImageToDataUri(
  payload: ImagePayload,
  maxEdge: number,
): Promise<string> {
  const sourceUri = `data:${payload.mime};base64,${payload.base64}`
  const image = await loadImage(sourceUri)

  const targetEdge = Math.min(maxEdge, Math.max(image.naturalWidth, image.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = targetEdge
  canvas.height = targetEdge
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    // Couldn't paint — return the original. Rare browser failure path.
    return sourceUri
  }

  // Center-crop to square, then draw at target edge.
  const sourceEdge = Math.min(image.naturalWidth, image.naturalHeight)
  const sx = Math.max(0, (image.naturalWidth - sourceEdge) / 2)
  const sy = Math.max(0, (image.naturalHeight - sourceEdge) / 2)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, sx, sy, sourceEdge, sourceEdge, 0, 0, targetEdge, targetEdge)

  // PNG preserves transparency; JPEG is significantly smaller for
  // photo-like content. Keep PNG for anything that could have alpha.
  const preservesAlpha = payload.mime === 'image/png'
    || payload.mime === 'image/webp'
    || payload.mime === 'image/gif'
  const mime = preservesAlpha ? 'image/png' : 'image/jpeg'
  return canvas.toDataURL(mime, 0.9)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Could not decode the uploaded image.'))
    image.src = src
  })
}

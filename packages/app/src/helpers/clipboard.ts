export async function writeTextToClipboard(text: string) {
  if (!text) return false

  try {
    if (window.coworkApi?.clipboard?.writeText) {
      const copied = await window.coworkApi.clipboard.writeText(text)
      if (copied) return true
    }
  } catch {
    // Fall back to the browser clipboard API below.
  }

  try {
    if (!navigator.clipboard?.writeText) return false
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

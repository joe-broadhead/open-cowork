export async function writeTextToClipboard(text: string) {
  if (!text) return false

  try {
    if (window.coworkApi?.clipboard?.writeText) {
      return window.coworkApi.clipboard.writeText(text)
    }

    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

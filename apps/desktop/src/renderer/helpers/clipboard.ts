export async function writeTextToClipboard(text: string) {
  if (!text) return false

  try {
    if (window.coworkApi?.clipboard?.writeText) {
      if (await window.coworkApi.clipboard.writeText(text)) {
        return true
      }
    }

    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

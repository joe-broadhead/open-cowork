export function formatAgentLabel(name: string | null | undefined) {
  if (!name) return ''
  return name
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

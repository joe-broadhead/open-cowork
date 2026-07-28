export function finding(code, path, message) {
  return Object.freeze({ code, path, message })
}

export function formatFinding(value) {
  return `[${value.code}] ${value.path}: ${value.message}`
}

export function assertNoFindings(findings, label = 'deployment configuration') {
  if (findings.length === 0) return
  throw new Error(
    `${label} failed executable validation:\n${findings.map((value) => `- ${formatFinding(value)}`).join('\n')}`,
  )
}

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const preloadPath = join(root, 'apps/desktop/src/preload/index.ts')
const mainSourcePath = join(root, 'apps/desktop/src/main')
const source = readFileSync(preloadPath, 'utf8')

const checks = [
  {
    label: 'invoke',
    arrayName: 'PRELOAD_INVOKE_CHANNELS',
    callPattern: /\binvoke\('([^']+)'/g,
  },
  {
    label: 'send',
    arrayName: 'PRELOAD_SEND_CHANNELS',
    callPattern: /\bsend\('([^']+)'/g,
  },
  {
    label: 'listen',
    arrayName: 'PRELOAD_LISTEN_CHANNELS',
    callPattern: /\blisten\('([^']+)'/g,
  },
]

const errors = []

for (const check of checks) {
  const listed = extractConstStringArray(check.arrayName)
  const used = extractMatches(check.callPattern)
  const missing = difference(used, listed)
  const stale = difference(listed, used)

  if (missing.length > 0 || stale.length > 0) {
    errors.push(formatDrift(check.label, check.arrayName, missing, stale))
  }
}

const whitelistedInvokes = extractConstStringArray('PRELOAD_INVOKE_CHANNELS')
const handledInvokes = extractMainHandledInvokeChannels()
const missingHandlers = difference(whitelistedInvokes, handledInvokes)
if (missingHandlers.length > 0) {
  errors.push(formatMainHandlerDrift(missingHandlers))
}

if (errors.length > 0) {
  process.stderr.write(`Preload channel whitelist drift detected:\n${errors.join('\n')}\n`)
  process.exit(1)
}

process.stdout.write('Preload channel whitelist matches the typed bridge and main handlers\n')

function extractConstStringArray(name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s+as\\s+const`))
  if (!match) {
    throw new Error(`Could not find ${name} in ${preloadPath}`)
  }
  return extractStringLiterals(match[1])
}

function extractMatches(pattern) {
  const values = []
  for (const match of source.matchAll(pattern)) {
    values.push(match[1])
  }
  return uniqueSorted(values)
}

function extractStringLiterals(content) {
  return uniqueSorted(Array.from(content.matchAll(/'([^']+)'/g), (match) => match[1]))
}

function extractMainHandledInvokeChannels() {
  const files = collectSourceFiles(mainSourcePath)
  const channels = []
  for (const file of files) {
    const content = readFileSync(file, 'utf8')
    for (const match of content.matchAll(/\.handle\('([^']+)'/g)) {
      channels.push(match[1])
    }
  }
  return uniqueSorted(channels)
}

function collectSourceFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(path))
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(path)
    }
  }
  return files
}

function uniqueSorted(values) {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b))
}

function difference(left, right) {
  const rightSet = new Set(right)
  return left.filter((value) => !rightSet.has(value))
}

function formatDrift(label, arrayName, missing, stale) {
  const lines = [`\n${label} channels (${arrayName})`]
  if (missing.length > 0) {
    lines.push(`  missing from whitelist: ${missing.join(', ')}`)
  }
  if (stale.length > 0) {
    lines.push(`  listed but unused: ${stale.join(', ')}`)
  }
  return lines.join('\n')
}

function formatMainHandlerDrift(missingHandlers) {
  return [
    '\ninvoke channels (main ipc handlers)',
    `  whitelisted without main handler: ${missingHandlers.join(', ')}`,
  ].join('\n')
}

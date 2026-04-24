import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

const root = process.cwd()
const errors = []
const textExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.yml', '.yaml'])
const ignoredDirs = new Set([
  '.git',
  '.opencode',
  '.venv-docs',
  'dist',
  'node_modules',
  'release',
  'site',
])
const consoleLogAllowlist = new Set([
  'apps/desktop/src/main/logger.ts',
  'scripts/lint.mjs',
])
const secretScanAllowlist = new Set([
  'apps/desktop/src/main/log-sanitizer.ts',
  'scripts/lint.mjs',
  'tests/log-sanitizer.test.ts',
])
const ignoredFiles = new Set([
  'apps/desktop/index.js',
])
const secretPatterns = [
  { name: 'Google OAuth client secret', pattern: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { name: 'API key', pattern: /\bsk-(?:or-|ant-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Azure connection string', pattern: /\bDefaultEndpointsProtocol=https?;AccountName=[^;\s]+;AccountKey=[^;\s]+/i },
  { name: 'keyed high-entropy secret', pattern: /\b(?:api[_-]?key|token|secret|password|client[_-]?secret)\s*[:=]\s*['"]?[A-Za-z0-9+/=_-]{32,}/i },
]

function visit(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      visit(fullPath)
      continue
    }
    lintFile(fullPath)
  }
}

function lintFile(fullPath) {
  const relPath = relative(root, fullPath)
  if (ignoredFiles.has(relPath)) return
  const ext = extname(fullPath)
  if (!textExtensions.has(ext)) return

  const content = readFileSync(fullPath, 'utf8')
  const lines = content.split('\n')

  lines.forEach((line, index) => {
    const lineNo = index + 1
    if (/\s+$/.test(line) && line.length > 0) {
      errors.push(`${relPath}:${lineNo} trailing whitespace`)
    }
    if (/\t/.test(line)) {
      errors.push(`${relPath}:${lineNo} tab character`)
    }
  })

  if (!content.endsWith('\n')) {
    errors.push(`${relPath}: missing trailing newline`)
  }

  if ((ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mjs')
    && !consoleLogAllowlist.has(relPath)
    && /\bconsole\.log\s*\(/.test(content)) {
    errors.push(`${relPath}: console.log is forbidden outside the main logger`)
  }

  if (!secretScanAllowlist.has(relPath)) {
    for (const { name, pattern } of secretPatterns) {
      if (pattern.test(content)) {
        errors.push(`${relPath}: possible ${name} committed to source`)
      }
    }
  }
}

visit(root)

if (errors.length) {
  console.error('Lint failed:\n' + errors.map((entry) => `- ${entry}`).join('\n'))
  process.exit(1)
}

const checkedFiles = countFiles(root)
console.log(`Lint passed across ${checkedFiles} files`)

function countFiles(dir) {
  let count = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      count += countFiles(fullPath)
      continue
    }
    if (textExtensions.has(extname(fullPath)) && statSync(fullPath).isFile()) {
      count += 1
    }
  }
  return count
}

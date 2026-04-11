import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

const root = process.cwd()
const errors = []
const textExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.yml', '.yaml'])
const ignoredDirs = new Set(['.git', 'node_modules', '.opencode', 'dist', 'release'])
const consoleLogAllowlist = new Set([
  'apps/desktop/src/main/logger.ts',
  'scripts/lint.mjs',
])
const ignoredFiles = new Set([
  'apps/desktop/index.js',
])

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

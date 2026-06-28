import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, extname } from 'node:path'

const root = process.cwd()
const errors = []
const styleLintExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.yml', '.yaml'])
const secretScanExtensions = new Set([
  ...styleLintExtensions,
  '.md',
  '.json',
  '.jsonc',
  '.toml',
  '.sh',
])
const secretScanFilenames = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
])
const ignoredDirs = new Set([
  '.git',
  '.claude',
  '.generated',
  '.open-cowork-test',
  '.opencode',
  '.pnpm-store',
  '.venv-docs',
  'coverage',
  'dist',
  'dist-browser',
  'node_modules',
  'release',
  'site',
])
const consoleLogAllowlist = new Set([
  'packages/shared/src/node/logger.ts',
  'scripts/lint.mjs',
])
const secretScanAllowlist = new Set([
  'packages/shared/src/log-sanitizer.ts',
  'scripts/lint.mjs',
  'tests/log-sanitizer.test.ts',
])
const privateSdkAccessAllowlist = new Set([
  'scripts/lint.mjs',
])
const legacyNamingAllowlist = new Set([
  'AGENTS.md',
  'docs/architecture.md',
  'docs/configuration.md',
  'docs/custom-mcps.md',
  'docs/downstream-contract.md',
  'docs/downstream.md',
  'open-cowork.config.json',
  'scripts/desktop-dist.mjs',
  'scripts/lint.mjs',
  'scripts/perf/suite.ts',
  '.github/workflows/release.yml',
  'packages/runtime-host/src/agent-config.ts',
  'packages/runtime-host/src/config-layer-utils.ts',
  'packages/runtime-host/src/config-loader-core.ts',
  'packages/runtime-host/src/config-public.ts',
  'packages/shared/src/config-types.ts',
  'packages/runtime-host/src/custom-agent-store.ts',
  'packages/runtime-host/src/runtime-config-builder.ts',
  'packages/app/src/helpers/i18n.ts',
  'packages/app/src/components/chat/useTaskDrillInLayout.ts',
])
const legacyNamingAllowlistPatterns = [
  /^tests\//,
  /^apps\/desktop\/tests\//,
  /^packages\/app\/src\/.*\.test\.tsx$/,
  /^packages\/app\/src\/test\//,
]
const ignoredFiles = new Set([
  'docs/javascripts/vendor/mermaid.min.js',
])
const secretPatterns = [
  { name: 'Google OAuth client secret', pattern: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { name: 'API key', pattern: /\bsk-(?:or-|ant-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Azure connection string', pattern: /\bDefaultEndpointsProtocol=https?;AccountName=[^;\s]+;AccountKey=[^;\s]+/i },
  { name: 'keyed high-entropy secret', pattern: /\b(?:api[_-]?key|token|secret|password|client[_-]?secret)\s*[:=]\s*['"]?[A-Za-z0-9+/=_-]{32,}/i },
]
const privateSdkAccessPatterns = [
  {
    name: 'google-auth-library private redirectUri mutation',
    pattern: /\._redirectUri\b/,
    guidance: 'Use OAuth2ClientOptions.redirectUri or GetTokenOptions.redirect_uri instead.',
  },
]
const rendererArbitraryFontSizeLimit = 0
const arbitraryFontSizePattern = /\btext-\[\d+px\]/g
let rendererArbitraryFontSizeCount = 0
const rendererRawPaletteLimit = 0
const rawPaletteStatusPattern =
  /\b(?:text|bg|border|ring|ring-offset|from|to|via|fill|stroke|outline|divide|decoration|caret|accent)-(?:green|emerald|lime|teal|amber|yellow|orange|red|rose|pink|sky|cyan|blue|indigo|violet|purple)-[0-9]{2,3}\b/g
let rendererRawPaletteCount = 0

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
  const shouldLintStyle = styleLintExtensions.has(ext)
  const shouldScanSecrets = shouldScanSecretPath(relPath)
  if (!shouldLintStyle && !shouldScanSecrets) return

  const content = readFileSync(fullPath, 'utf8')
  const lines = content.split('\n')

  if (shouldLintStyle) {
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
  }

  if (shouldLintStyle
    && (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mjs')
    && !consoleLogAllowlist.has(relPath)
    && /\bconsole\.log\s*\(/.test(content)) {
    errors.push(`${relPath}: console.log is forbidden outside the main logger`)
  }

  if (shouldLintStyle
    && (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mjs')
    && !privateSdkAccessAllowlist.has(relPath)) {
    for (const { name, pattern, guidance } of privateSdkAccessPatterns) {
      if (pattern.test(content)) {
        errors.push(`${relPath}: forbidden ${name}. ${guidance}`)
      }
    }
  }

  if (shouldLintStyle && relPath.startsWith('packages/app/src/')) {
    rendererArbitraryFontSizeCount += content.match(arbitraryFontSizePattern)?.length || 0
    rendererRawPaletteCount += content.match(rawPaletteStatusPattern)?.length || 0
    if (/\bwindow\.(?:alert|confirm)\s*\(/.test(content)) {
      errors.push(`${relPath}: native window.alert/window.confirm is banned in the renderer — it blocks the window and breaks the design system. Use toast() for messages and the shared <Dialog> or confirm.requestDestructive for confirmations.`)
    }
    if (ext === '.tsx') validateIconButtonLabels(relPath, content)
  }

  if (/\b(?:opencowork|OpenCowork)\b/.test(content) && !isLegacyNamingAllowed(relPath)) {
    errors.push(`${relPath}: use "open-cowork" publicly; legacy "opencowork" is allowed only for documented back-compat namespaces`)
  }

  if (shouldScanSecrets && !secretScanAllowlist.has(relPath)) {
    for (const { name, pattern } of secretPatterns) {
      if (pattern.test(content)) {
        errors.push(`${relPath}: possible ${name} committed to source`)
      }
    }
  }
}

visit(root)
validateRendererDesignSystemGates()
validateArchitectureSdkVersionPolicy()

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
    const relPath = relative(root, fullPath)
    if ((styleLintExtensions.has(extname(fullPath)) || shouldScanSecretPath(relPath)) && statSync(fullPath).isFile()) {
      count += 1
    }
  }
  return count
}

function shouldScanSecretPath(relPath) {
  return secretScanExtensions.has(extname(relPath)) || secretScanFilenames.has(basename(relPath))
}

function isLegacyNamingAllowed(relPath) {
  return legacyNamingAllowlist.has(relPath)
    || legacyNamingAllowlistPatterns.some((pattern) => pattern.test(relPath))
}

function validateArchitectureSdkVersionPolicy() {
  try {
    const desktopPackage = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8'))
    const runtimeVersion = desktopPackage.dependencies?.['opencode-ai']
    const sdkVersion = desktopPackage.dependencies?.['@opencode-ai/sdk']
    const architecture = readFileSync(join(root, 'docs/architecture.md'), 'utf8')

    if (typeof runtimeVersion !== 'string' || typeof sdkVersion !== 'string') {
      errors.push('apps/desktop/package.json: missing explicit opencode-ai / @opencode-ai/sdk dependency pins')
      return
    }
    for (const requiredText of ['opencode-ai', '@opencode-ai/sdk', 'apps/desktop/package.json', 'pnpm-lock.yaml']) {
      if (!architecture.includes(requiredText)) {
        errors.push(`docs/architecture.md: OpenCode SDK version policy must reference ${requiredText}`)
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    errors.push(`docs/architecture.md: unable to verify OpenCode SDK version policy: ${message}`)
  }
}

function validateRendererDesignSystemGates() {
  if (rendererArbitraryFontSizeCount > rendererArbitraryFontSizeLimit) {
    errors.push(
      `packages/app/src: ${rendererArbitraryFontSizeCount} arbitrary text-[Npx] utilities found; `
      + `these are banned. Use a paired type-scale utility instead (text-2xs/xs/sm/md/lg/xl/2xl/3xl/hero) `
      + `or a .text-role-* class so size and line-height stay on the token scale.`,
    )
  }
  if (rendererRawPaletteCount > rendererRawPaletteLimit) {
    errors.push(
      `packages/app/src: ${rendererRawPaletteCount} raw Tailwind palette status utilities found `
      + `(e.g. text-amber-200, bg-red-500, border-sky-400); these bypass the cool theme. Use the semantic `
      + `token utilities instead (text/bg/border-{green|amber|red|info|accent}) so the themed hues apply.`,
    )
  }
}

function validateIconButtonLabels(relPath, content) {
  const iconButtonPattern = /<IconButton\b/g
  for (const match of content.matchAll(iconButtonPattern)) {
    const start = match.index || 0
    const tag = readJsxOpeningTag(content, start)
    if (!tag) continue
    if (/\blabel\s*=/.test(tag)) continue
    const lineNo = content.slice(0, start).split('\n').length
    errors.push(`${relPath}:${lineNo} IconButton must include a label prop`)
  }
}

function readJsxOpeningTag(content, start) {
  let quote = null
  let expressionDepth = 0

  for (let index = start; index < content.length; index += 1) {
    const char = content[index]
    const prev = content[index - 1]

    if (quote) {
      if (char === quote && prev !== '\\') quote = null
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '{') {
      expressionDepth += 1
      continue
    }
    if (char === '}') {
      expressionDepth = Math.max(0, expressionDepth - 1)
      continue
    }
    if (char === '>' && expressionDepth === 0) {
      return content.slice(start, index)
    }
  }

  return null
}

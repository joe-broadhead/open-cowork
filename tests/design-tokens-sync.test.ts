import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  cssColorLuminance,
  DEFAULT_DARK_PUBLIC_BRANDING_THEME,
  DEFAULT_PUBLIC_BRANDING,
  derivePublicBrandingThemeTokens,
  DESIGN_TOKENS,
  isLegacyLightPublicBrandingTheme,
} from '../packages/shared/dist/index.js'

function declarations(block: string) {
  return new Map([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)]
    .map((match) => [`--${match[1]}`, match[2].trim()]))
}

function namedBlock(source: string, name: string) {
  const match = source.match(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\n\\}`))
  assert.ok(match, `${name} block exists`)
  return match[1]
}

function desktopTokenDeclarations() {
  const globals = readFileSync('apps/desktop/src/renderer/styles/globals.css', 'utf8')
  return {
    theme: declarations(namedBlock(globals, '@theme')),
    root: declarations(namedBlock(globals, ':root')),
  }
}

function expectedThemeTokens() {
  return new Map<string, string>([
    ['--color-base', DESIGN_TOKENS.color.base],
    ['--color-surface', DESIGN_TOKENS.color.surface],
    ['--color-surface-hover', DESIGN_TOKENS.color.surfaceHover],
    ['--color-surface-active', DESIGN_TOKENS.color.surfaceActive],
    ['--color-elevated', DESIGN_TOKENS.color.elevated],
    ['--color-border', DESIGN_TOKENS.color.border],
    ['--color-border-subtle', DESIGN_TOKENS.color.borderSubtle],
    ['--color-text', DESIGN_TOKENS.color.text],
    ['--color-text-secondary', DESIGN_TOKENS.color.textSecondary],
    ['--color-text-muted', DESIGN_TOKENS.color.textMuted],
    ['--color-accent', DESIGN_TOKENS.color.accent],
    ['--color-accent-hover', DESIGN_TOKENS.color.accentHover],
    ['--color-green', DESIGN_TOKENS.color.green],
    ['--color-amber', DESIGN_TOKENS.color.amber],
    ['--color-red', DESIGN_TOKENS.color.red],
    ['--color-info', DESIGN_TOKENS.color.info],
    ['--color-accent-foreground', DESIGN_TOKENS.color.accentForeground],
  ])
}

function expectedRootTokens() {
  return new Map<string, string>([
    ['--font-ui', DESIGN_TOKENS.fontFamily.ui],
    ['--font-display', DESIGN_TOKENS.fontFamily.display],
    ['--font-mono', DESIGN_TOKENS.fontFamily.mono],
    ...Object.entries(DESIGN_TOKENS.text).map(([name, value]) => [`--text-${name}`, value] as [string, string]),
    ...Object.entries(DESIGN_TOKENS.lineHeight).map(([name, value]) => [`--lh-${name}`, value] as [string, string]),
    ...Object.entries(DESIGN_TOKENS.space).map(([name, value]) => [`--space-${name}`, value] as [string, string]),
    ...Object.entries(DESIGN_TOKENS.radius).map(([name, value]) => [`--radius-${name}`, value] as [string, string]),
    ['--shadow-card', DESIGN_TOKENS.shadow.card],
    ['--shadow-elevated', DESIGN_TOKENS.shadow.elevated],
    ['--bg-image', DESIGN_TOKENS.color.bgImage],
    ...Object.entries(DESIGN_TOKENS.ease).map(([name, value]) => [`--ease-${name}`, value] as [string, string]),
    ...Object.entries(DESIGN_TOKENS.duration).map(([name, value]) => [`--dur-${name}`, value] as [string, string]),
    ...Object.entries(DESIGN_TOKENS.z).map(([name, value]) => [`--z-${name}`, value] as [string, string]),
    ...Object.entries(DESIGN_TOKENS.controlHeight).map(([name, value]) => [`--control-h-${name}`, value] as [string, string]),
    ...Object.entries(DESIGN_TOKENS.borderWidth).map(([name, value]) => [`--border-width-${name}`, value] as [string, string]),
    ...Object.entries(DESIGN_TOKENS.iconSize).map(([name, value]) => [`--icon-size-${name}`, value] as [string, string]),
  ])
}

function ownedRootToken(name: string) {
  return [
    '--font-',
    '--text-',
    '--lh-',
    '--space-',
    '--radius-',
    '--shadow-',
    '--bg-image',
    '--ease-',
    '--dur-',
    '--z-',
    '--control-h-',
    '--border-width-',
    '--icon-size-',
  ].some((prefix) => name === prefix || name.startsWith(prefix))
}

test('shared design tokens match desktop globals.css', () => {
  const desktop = desktopTokenDeclarations()
  const theme = expectedThemeTokens()
  const root = expectedRootTokens()

  for (const [name, value] of theme) {
    assert.equal(desktop.theme.get(name), value, `${name} matches desktop @theme`)
  }
  for (const [name, value] of root) {
    assert.equal(desktop.root.get(name), value, `${name} matches desktop :root`)
  }

  const expectedThemeNames = new Set(theme.keys())
  for (const name of desktop.theme.keys()) {
    assert.ok(expectedThemeNames.has(name), `${name} is represented by shared design tokens`)
  }

  const expectedRootNames = new Set(root.keys())
  for (const name of desktop.root.keys()) {
    if (!ownedRootToken(name)) continue
    assert.ok(expectedRootNames.has(name), `${name} is represented by shared design tokens`)
  }
})

test('desktop font package dependencies are present for cloud font serving', () => {
  const packageJson = JSON.parse(readFileSync('apps/desktop/package.json', 'utf8')) as {
    dependencies?: Record<string, string>
  }
  assert.ok(packageJson.dependencies?.['@fontsource-variable/mona-sans'], 'Mona Sans font package is a desktop dependency')
  assert.ok(packageJson.dependencies?.['@fontsource-variable/hubot-sans'], 'Hubot Sans font package is a desktop dependency')
})

test('design docs describe the shared Cloud Web and Desktop token contract', () => {
  const designSystem = readFileSync('docs/design-system.md', 'utf8')
  const designTokens = readFileSync('docs/design-tokens.md', 'utf8')
  const configuration = readFileSync('docs/configuration.md', 'utf8')
  const downstream = readFileSync('docs/downstream.md', 'utf8')
  const downstreamContract = readFileSync('docs/downstream-contract.md', 'utf8')
  const cloudWeb = readFileSync('docs/cloud-web-workbench.md', 'utf8')
  const releaseChecklist = readFileSync('docs/release-checklist.md', 'utf8')

  for (const doc of [designSystem, designTokens, downstream, downstreamContract]) {
    assert.match(doc, /packages\/shared\/src\/design-tokens\.ts/)
  }
  assert.match(designSystem, /emitRootTokensCss\(\)/)
  assert.match(designTokens, /DEFAULT_DARK_BRAND_THEME/)
  assert.match(designTokens, /Public Branding Theme Keys/)
  assert.match(designTokens, /surfaceHover/)
  assert.match(designTokens, /shadowElevated/)
  assert.match(configuration, /Cloud Web defaults to the shared Desktop dark palette/)
  assert.match(configuration, /Legacy light partial theme overrides/)
  assert.match(downstream, /should not fork Cloud Web\s+layout CSS/)
  assert.match(downstreamContract, /bypass the Desktop\/Cloud Web drift gates/)
  assert.match(cloudWeb, /Visual QA Checklist/)
  assert.match(cloudWeb, /\/assets\/fonts\/\*\.woff2/)
  assert.match(releaseChecklist, /Cloud Web and Desktop visual parity checklist/)
})

test('shared public branding default uses the canonical dark theme', () => {
  assert.deepEqual(DEFAULT_PUBLIC_BRANDING.theme, DEFAULT_DARK_PUBLIC_BRANDING_THEME)
})

test('public branding light detection handles accepted literal color tokens', () => {
  assert.ok((cssColorLuminance('#fff') || 0) > 0.95)
  assert.ok((cssColorLuminance('rgb(255, 255, 255)') || 0) > 0.95)
  assert.ok((cssColorLuminance('white') || 0) > 0.95)
  assert.ok((cssColorLuminance('hsl(0, 0%, 100%)') || 0) > 0.95)
  assert.ok((cssColorLuminance('black') ?? 1) < 0.01)
  assert.ok((cssColorLuminance('rgba(255, 255, 255, 0.4)') ?? 1) < 0.55)
  assert.equal(cssColorLuminance('radial-gradient(circle, #fff, #000)'), null)

  assert.equal(isLegacyLightPublicBrandingTheme({ surface: '#fff' }), true)
  assert.equal(isLegacyLightPublicBrandingTheme({ surface: 'rgb(255, 255, 255)' }), true)
  assert.equal(isLegacyLightPublicBrandingTheme({ surface: 'white' }), true)
  assert.equal(isLegacyLightPublicBrandingTheme({ surface: 'hsl(0, 0%, 100%)' }), true)
  assert.equal(derivePublicBrandingThemeTokens({ surface: '#fff' }).text, '#18211c')
})

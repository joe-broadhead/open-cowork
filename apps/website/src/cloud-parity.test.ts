import test from 'node:test'
import assert from 'node:assert/strict'
import { emitRootTokensCss } from '@open-cowork/shared'
import { cloudWebsiteStyles } from './styles.ts'
import { DEFAULT_WEBSITE_PUBLIC_BRANDING } from './branding.ts'

// Cross-surface parity guard.
//
// The product ships as two surfaces — the Electron desktop renderer and this
// Cloud Web app — and they must stay visually identical. The desktop bakes the
// shared design tokens into a generated stylesheet (checked by
// tests/design-tokens-sync.test.ts); these assertions are the matching guard
// for Cloud Web, so a value can only diverge between the two surfaces by
// editing the single shared source, not by drifting one surface on its own.

const css = cloudWebsiteStyles(DEFAULT_WEBSITE_PUBLIC_BRANDING)

test('cloud web embeds the shared design-token source verbatim (one token source for both surfaces)', () => {
  // The website must derive its root tokens from the exact generator the
  // desktop ships from. If this drifts, the two surfaces no longer share a
  // single source of truth for colour/spacing/typography.
  assert.ok(
    css.includes(emitRootTokensCss()),
    'Cloud Web base styles must embed emitRootTokensCss() verbatim',
  )
})

test('cloud web shell uses the shared studio shell tokens (no per-surface sidebar drift)', () => {
  // The shared studio shell tokens are the single source for both surfaces.
  assert.match(css, /--studio-shell-sidebar-w:\s*268px/)
  assert.match(css, /--studio-shell-rail-w:\s*72px/)
  // The cloud shell must reference those shared tokens, not a forked literal.
  assert.match(css, /--cloud-shell-sidebar-w:\s*var\(--studio-shell-sidebar-w\)/)
  assert.match(css, /--cloud-shell-sidebar-rail-w:\s*var\(--studio-shell-rail-w\)/)
  // Guard against re-introducing the old 248px/64px desktop-vs-web divergence.
  assert.doesNotMatch(css, /--cloud-shell-sidebar-w:\s*248px/)
  assert.doesNotMatch(css, /--cloud-shell-sidebar-rail-w:\s*64px/)
})

test('cloud web ships the flat Mercury base — no atmosphere glow or film-grain decoration', () => {
  // The "clean Mercury graphite" identity sits on a flat base. These are the
  // decorations the design brief requires deleted from both surfaces.
  assert.doesNotMatch(css, /ui-atmosphere-drift/)
  assert.doesNotMatch(css, /fractalNoise/)
  assert.doesNotMatch(css, /--bg-image:\s*radial-gradient/)
})

test('cloud web uses the brand white action ink (matches desktop)', () => {
  // White text on the blue action fill is locked brand identity; the desktop
  // generated token sheet asserts the same value.
  assert.match(css, /--accent-action-foreground:\s*#ffffff/)
})

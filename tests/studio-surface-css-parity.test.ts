import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Cross-surface CSS single-source guard.
//
// The shared @open-cowork/ui surfaces are styled once, in
// packages/ui/src/surface-styles.ts, and both the desktop renderer and Cloud Web
// consume that one stylesheet. Historically each surface's CSS was hand-written
// twice (desktop globals.css + the website style-*.ts files), which is how the
// two surfaces drifted. This test enforces that, for every surface already
// consolidated, its selectors live ONLY in the shared module and are never
// re-duplicated into an app's local CSS. Add a surface's selector prefixes here
// as you migrate it — the guard then keeps it from regressing.

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const SINGLE_SOURCED_PREFIXES = [
  '.studio-artifacts-',
  '.studio-artifact-card',
  '.studio-approvals-',
  '.studio-approval-item',
  '.studio-approval-command',
  '.studio-question-',
  '.studio-wiki-page',
  '.studio-wiki-rail',
  '.studio-wiki-space',
  '.studio-wiki-propose',
  '.ui-empty-state',
  '.ui-skeleton',
  // Primitive controls — the input/textarea/select-trigger/menu-trigger/field/popover
  // rules previously lived ONLY in desktop globals.css (so the controls rendered with
  // raw browser defaults on web). Now single-sourced in controlsSurfaceCss(). NOTE the
  // byte-identical button base/sizes/secondary/ghost/danger move there too, but
  // `.ui-button--primary` deliberately stays app-local (the desktop gradient fill differs
  // from the website flat fill), so the broad `.ui-button` prefix is intentionally absent.
  '.ui-input',
  '.ui-field',
  '.ui-select-trigger',
  '.ui-menu-trigger',
  '.ui-popover-root',
  '.ui-popover-item',
  // Cross-app animation keyframes (defined once in sharedKeyframesCss). Desktop-only
  // `ui-spin`/`ui-disclosure-in` are intentionally NOT listed — they stay in globals.css.
  '@keyframes ui-fade-in',
  '@keyframes ui-popover-in',
  '@keyframes ui-view-transition-in',
  '@keyframes ui-view-transition-out',
  '@keyframes ui-dialog-in',
  '@keyframes ui-drawer-in',
  '@keyframes ui-drawer-left-in',
  '@keyframes ui-primary-sheen',
  '@keyframes ui-status-pulse',
  '@keyframes ui-progress-shimmer',
  '@keyframes ui-stream-shimmer',
  '@keyframes ui-stream-caret',
  '@keyframes ui-polish-row-in',
]

const sharedCss = readFileSync(join(root, 'packages/ui/src/surface-styles.ts'), 'utf8')
const desktopCss = readFileSync(join(root, 'apps/desktop/src/renderer/styles/globals.css'), 'utf8')

for (const prefix of SINGLE_SOURCED_PREFIXES) {
  test(`shared @open-cowork/ui surface CSS is the single source for ${prefix}`, () => {
    assert.ok(
      sharedCss.includes(prefix),
      `${prefix} must be defined in packages/ui/src/surface-styles.ts`,
    )
    assert.ok(
      !desktopCss.includes(prefix),
      `${prefix} is consolidated — it must not be re-defined in apps/desktop globals.css`,
    )
  })
}

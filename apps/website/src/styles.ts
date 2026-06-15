import { cssColorLuminance, emitRootTokensCss, type PublicBrandingConfig } from '@open-cowork/shared'
import { publicBrandingCss } from './branding.ts'
import { cloudWebsiteAgentProfileStyles } from './style-agent-profile.ts'
import { cloudWebsiteArtifactStyles } from './style-artifacts.ts'
import { cloudWebsiteChatStyles } from './style-chat.ts'
import { cloudWebsiteComponentStyles } from './style-components.ts'
import { cloudWebsiteLaunchpadStyles } from './style-launchpad.ts'
import { cloudWebsiteLayoutStyles } from './style-layout.ts'
import { cloudWebsitePrimitiveStyles } from './style-primitives.ts'
import { cloudWebsiteSharedUiStyles } from './style-shared-ui.ts'
import { cloudWebsiteSettingsStyles } from './style-settings.ts'
import { cloudWebsiteStudioUiStyles } from './style-studio-ui.ts'
import { cloudWebsiteStudioPrimitiveStyles } from './style-studio-primitives.ts'

const FONT_UNICODE_RANGE = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'

function cloudWebsiteColorScheme(branding: PublicBrandingConfig) {
  const background = cssColorLuminance(branding.theme?.background)
  const text = cssColorLuminance(branding.theme?.text)
  return background !== null && text !== null && background > text ? 'light' : 'dark'
}

function cloudWebsiteFontFaces() {
  return String.raw`@font-face {
  font-family: 'Mona Sans Variable';
  font-style: normal;
  font-display: block;
  font-weight: 200 900;
  src: url('/assets/fonts/mona-sans-latin-wght-normal.woff2') format('woff2-variations');
  unicode-range: ${FONT_UNICODE_RANGE};
}
@font-face {
  font-family: 'Mona Sans Variable';
  font-style: italic;
  font-display: block;
  font-weight: 200 900;
  src: url('/assets/fonts/mona-sans-latin-wght-italic.woff2') format('woff2-variations');
  unicode-range: ${FONT_UNICODE_RANGE};
}
@font-face {
  font-family: 'Schibsted Grotesk Variable';
  font-style: normal;
  font-display: block;
  font-weight: 200 900;
  src: url('/assets/fonts/schibsted-grotesk-latin-wght-normal.woff2') format('woff2-variations');
  unicode-range: ${FONT_UNICODE_RANGE};
}
@font-face {
  font-family: 'Schibsted Grotesk Variable';
  font-style: italic;
  font-display: block;
  font-weight: 200 900;
  src: url('/assets/fonts/schibsted-grotesk-latin-wght-italic.woff2') format('woff2-variations');
  unicode-range: ${FONT_UNICODE_RANGE};
}`
}

function cloudWebsiteBaseStyles(branding: PublicBrandingConfig) {
  return String.raw`${emitRootTokensCss()}
    :root {
      color-scheme: ${cloudWebsiteColorScheme(branding)};
${publicBrandingCss(branding)}
      --cloud-shell-sidebar-w: 248px;
      --shadow: var(--shadow-card);
      --surface-highlight: inset 0 1px 0 color-mix(in srgb, var(--color-text) 5%, transparent);
      --field-bg: color-mix(in srgb, var(--color-base) 72%, var(--color-elevated) 28%);
      --field-border: var(--color-border);
      --ring-focus: 0 0 0 2px var(--focus), 0 0 16px color-mix(in srgb, var(--accent) 30%, transparent);
      --ring-selected: inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 70%, transparent);
      --tone-neutral-bg: color-mix(in srgb, var(--color-surface-hover) 88%, transparent);
      --tone-ok-bg: color-mix(in srgb, var(--color-green) 14%, var(--color-elevated) 86%);
      --tone-ok-border: color-mix(in srgb, var(--color-green) 42%, var(--color-border) 58%);
      --tone-warn-bg: color-mix(in srgb, var(--color-amber) 14%, var(--color-elevated) 86%);
      --tone-warn-border: color-mix(in srgb, var(--color-amber) 42%, var(--color-border) 58%);
      --tone-danger-bg: color-mix(in srgb, var(--color-red) 14%, var(--color-elevated) 86%);
      --tone-danger-border: color-mix(in srgb, var(--color-red) 42%, var(--color-border) 58%);
      --tone-info-bg: color-mix(in srgb, var(--color-info) 14%, var(--color-elevated) 86%);
      --tone-info-border: color-mix(in srgb, var(--color-info) 42%, var(--color-border) 58%);
      font-family: var(--font-ui);
    }
    * { box-sizing: border-box; }
    html {
      min-height: 100%;
      background: var(--color-base);
    }
    body {
      position: relative;
      margin: 0;
      min-height: 100vh;
      background-color: var(--bg);
      background-image: var(--bg-image);
      background-attachment: fixed;
      background-repeat: no-repeat;
      background-size: 100% 100%;
      color: var(--text);
      font-family: var(--font-ui);
      font-size: var(--text-md);
      line-height: var(--lh-md);
      font-feature-settings: "tnum" 1, "cv01" 1;
      font-variant-numeric: tabular-nums;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }
    body::before,
    body::after {
      content: "";
      position: fixed;
      inset: 0;
      z-index: 0;
      pointer-events: none;
    }
    body::before {
      inset: -24%;
      background:
        radial-gradient(42% 38% at 18% 10%, color-mix(in srgb, var(--accent) 20%, transparent), transparent 62%),
        radial-gradient(36% 40% at 82% 8%, color-mix(in srgb, var(--accent-strong) 14%, transparent), transparent 64%),
        radial-gradient(48% 44% at 62% 108%, color-mix(in srgb, var(--color-info) 12%, transparent), transparent 62%);
      filter: blur(20px);
      opacity: 0.42;
      animation: ui-atmosphere-drift 26s var(--ease-spring) infinite alternate;
    }
    body::after {
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
      mix-blend-mode: overlay;
      opacity: 0.026;
    }
    button, input, select, textarea {
      font: inherit;
    }
    @keyframes ui-fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes ui-popover-in {
      from { opacity: 0; transform: translateY(calc(-1 * var(--space-1))) scale(0.985); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes ui-view-transition-in {
      from { opacity: 0; transform: translateY(var(--space-2)); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes ui-view-transition-out {
      from { opacity: 1; transform: translateY(0); }
      to { opacity: 0; transform: translateY(calc(-1 * var(--space-1))); }
    }
    ::view-transition-old(root) {
      animation: ui-view-transition-out var(--dur-2) var(--ease-out) both;
    }
    ::view-transition-new(root) {
      animation: ui-view-transition-in var(--dur-3) var(--ease-spring) both;
    }
    @keyframes ui-primary-sheen {
      from { transform: skewX(-18deg) translateX(0); }
      to { transform: skewX(-18deg) translateX(430%); }
    }
    @keyframes ui-polish-row-in {
      from { opacity: 0; transform: translateX(calc(-1 * var(--space-2))); }
      to { opacity: 1; transform: translateX(0); }
    }
    @keyframes ui-status-pulse {
      0% { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 42%, transparent); }
      70% { box-shadow: 0 0 0 var(--space-2) transparent; }
      100% { box-shadow: 0 0 0 0 transparent; }
    }
    @keyframes ui-progress-shimmer {
      from { background-position: 220% 0; }
      to { background-position: -220% 0; }
    }
    @keyframes ui-atmosphere-drift {
      from { transform: translate3d(0, 0, 0) scale(1); }
      to { transform: translate3d(2%, 1.5%, 0) scale(1.08); }
    }
    @keyframes ui-stream-shimmer {
      to { background-position: -220% 0; }
    }
    @keyframes ui-stream-caret {
      50% { opacity: 0; }
    }
    body:not([data-auth="signed-in"]) .signed-in-only {
      display: none;
    }
    body[data-auth="signed-in"] .signed-out-only {
      display: none;
    }
    @media (prefers-reduced-motion: reduce) {
      :root {
        --dur-1: 0ms;
        --dur-2: 0ms;
        --dur-3: 0ms;
        --dur-4: 0ms;
      }
      *, *::before, *::after {
        animation-duration: 0ms !important;
        animation-iteration-count: 1 !important;
        scroll-behavior: auto !important;
        transition-duration: 0ms !important;
      }
      body::before {
        animation: none;
      }
      ::view-transition-old(root),
      ::view-transition-new(root) {
        animation: none !important;
      }
    }`
}

export function cloudWebsiteStyles(branding: PublicBrandingConfig) {
  return String.raw`${cloudWebsiteFontFaces()}
${cloudWebsiteBaseStyles(branding)}
${cloudWebsiteLayoutStyles()}
${cloudWebsiteComponentStyles()}
${cloudWebsitePrimitiveStyles()}
${cloudWebsiteAgentProfileStyles()}
${cloudWebsiteArtifactStyles()}
${cloudWebsiteChatStyles()}
${cloudWebsiteLaunchpadStyles()}
${cloudWebsiteSharedUiStyles()}
${cloudWebsiteSettingsStyles()}
${cloudWebsiteStudioPrimitiveStyles()}
${cloudWebsiteStudioUiStyles()}
`
}

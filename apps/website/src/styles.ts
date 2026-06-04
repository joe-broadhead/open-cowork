import { cssColorLuminance, emitRootTokensCss, type PublicBrandingConfig } from '@open-cowork/shared'
import { publicBrandingCss } from './branding.ts'

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
  font-family: 'Hubot Sans Variable';
  font-style: normal;
  font-display: block;
  font-weight: 200 900;
  src: url('/assets/fonts/hubot-sans-latin-wght-normal.woff2') format('woff2-variations');
  unicode-range: ${FONT_UNICODE_RANGE};
}
@font-face {
  font-family: 'Hubot Sans Variable';
  font-style: italic;
  font-display: block;
  font-weight: 200 900;
  src: url('/assets/fonts/hubot-sans-latin-wght-italic.woff2') format('woff2-variations');
  unicode-range: ${FONT_UNICODE_RANGE};
}`
}

export function cloudWebsiteStyles(branding: PublicBrandingConfig) {
  return String.raw`${cloudWebsiteFontFaces()}
${emitRootTokensCss()}
    :root {
      color-scheme: ${cloudWebsiteColorScheme(branding)};
${publicBrandingCss(branding)}
      --shadow: var(--shadow-card);
      --field-bg: color-mix(in srgb, var(--color-base) 78%, var(--color-elevated) 22%);
      --field-border: color-mix(in srgb, var(--color-border) 74%, var(--color-text-muted) 26%);
      --tone-ok-bg: color-mix(in srgb, var(--color-green) 14%, var(--color-elevated) 86%);
      --tone-ok-border: color-mix(in srgb, var(--color-green) 42%, var(--color-border) 58%);
      --tone-warn-bg: color-mix(in srgb, var(--color-amber) 14%, var(--color-elevated) 86%);
      --tone-warn-border: color-mix(in srgb, var(--color-amber) 42%, var(--color-border) 58%);
      --tone-danger-border: color-mix(in srgb, var(--color-red) 42%, var(--color-border) 58%);
      --ring-selected: inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 70%, transparent);
      font-family: var(--font-ui);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background-color: var(--bg);
      background-image: var(--bg-image);
      color: var(--text);
    }
    button, input, select, textarea {
      font: inherit;
    }
    button {
      min-height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface);
      color: var(--text);
      padding: 0 12px;
      cursor: pointer;
    }
    button:hover { border-color: var(--accent); }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--color-accent-foreground);
    }
    button.primary:hover {
      background: var(--accent-strong);
      border-color: var(--accent-strong);
    }
    button.danger {
      color: var(--danger);
      border-color: var(--tone-danger-border);
    }
    button.secondary {
      color: var(--accent);
    }
    button:disabled, input:disabled, select:disabled {
      opacity: 0.54;
      cursor: not-allowed;
    }
    a {
      color: var(--accent);
      text-decoration: none;
    }
    a:hover { text-decoration: underline; }
    input, select, textarea {
      min-height: 36px;
      border: 1px solid var(--field-border);
      border-radius: 6px;
      background: var(--field-bg);
      color: var(--text);
      padding: 0 10px;
      min-width: 0;
    }
    input::placeholder, textarea::placeholder {
      color: var(--muted);
    }
    textarea {
      min-height: 108px;
      padding: 9px 10px;
      resize: vertical;
      line-height: 1.45;
    }
    input:focus, select:focus, textarea:focus, button:focus-visible, a:focus-visible {
      outline: 2px solid var(--focus);
      outline-offset: 2px;
    }
    label {
      display: grid;
      gap: 5px;
      color: var(--muted);
      font-size: 12px;
      min-width: 0;
    }
    label span {
      color: var(--text);
      font-size: 13px;
      font-weight: 600;
    }
    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 248px minmax(0, 1fr);
    }
    .nav {
      background: var(--muted-surface);
      border-right: 1px solid var(--line);
      padding: 18px 14px;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .mark {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      background: var(--accent);
      color: var(--color-accent-foreground);
      font-weight: 700;
      flex: 0 0 auto;
    }
    .brand-logo {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      object-fit: contain;
      background: var(--surface);
      border: 1px solid var(--line);
      flex: 0 0 auto;
    }
    .brand-title, h1, h2 {
      margin: 0;
      font-weight: 700;
      letter-spacing: 0;
    }
    .brand-title { font-size: 15px; }
    .meta, small {
      color: var(--muted);
      font-size: 12px;
    }
    .nav-sections {
      display: grid;
      gap: 14px;
    }
    .nav-group {
      display: grid;
      gap: 6px;
    }
    .nav-heading {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 0 10px;
    }
    .nav-links {
      display: grid;
      gap: 4px;
    }
    .nav-links a {
      min-height: 34px;
      border-radius: 6px;
      padding: 8px 10px;
      color: var(--text);
    }
    .nav-links a:hover {
      background: var(--surface);
      text-decoration: none;
    }
    .nav-links a[data-active="true"] {
      background: var(--color-surface-active);
      border: 1px solid var(--line);
      box-shadow: var(--ring-selected);
    }
    .nav-links a[data-locked="true"] {
      color: var(--muted);
    }
    .brand-links {
      margin-top: auto;
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
      font-size: 12px;
    }
    .main {
      min-width: 0;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }
    .topbar {
      border-bottom: 1px solid var(--line);
      background: var(--surface);
      min-height: 68px;
      padding: 14px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .status {
      color: var(--muted);
      font-size: 13px;
    }
    .status[data-kind="error"] { color: var(--danger); }
    .status[data-kind="warn"] { color: var(--warn); }
    .status[data-kind="ok"] { color: var(--ok); }
    .content {
      overflow: auto;
      padding: 22px;
      display: grid;
      gap: 16px;
      align-content: start;
    }
    .section {
      border-top: 1px solid var(--line);
      padding-top: 16px;
      display: grid;
      gap: 12px;
    }
    [data-route-panel][hidden], [data-route-link][hidden] {
      display: none;
    }
    .section:first-child {
      border-top: 0;
      padding-top: 0;
    }
    .section-header {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 12px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .workbench-split {
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(280px, 0.6fr);
      gap: 12px;
      align-items: start;
    }
    .panel {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      display: grid;
      gap: 12px;
      box-shadow: var(--shadow);
      min-width: 0;
    }
    .panel h3 {
      margin: 0;
      font-size: 15px;
      letter-spacing: 0;
    }
    .form-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      align-items: end;
    }
    .form-grid .span {
      grid-column: 1 / -1;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: end;
    }
    .toolbar label {
      flex: 1 1 150px;
    }
    .check-row {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
    }
    .check-row label {
      display: flex;
      grid-template-columns: none;
      align-items: center;
      flex-direction: row;
      gap: 6px;
      color: var(--text);
      font-size: 13px;
    }
    .check-row input {
      min-height: 0;
    }
    .list {
      display: grid;
      gap: 8px;
    }
    .table-shell {
      display: grid;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: var(--surface);
    }
    .table-row {
      display: grid;
      grid-template-columns: minmax(180px, 1.4fr) minmax(90px, 0.6fr) minmax(110px, 0.7fr) minmax(120px, 0.7fr);
      gap: 10px;
      min-height: 42px;
      align-items: center;
      padding: 0 12px;
      border-top: 1px solid var(--line);
      font-size: 13px;
    }
    .table-row:first-child {
      border-top: 0;
    }
    .table-head {
      min-height: 34px;
      background: var(--muted-surface);
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .thread-row {
      width: 100%;
      text-align: left;
      border-left: 0;
      border-right: 0;
      border-bottom: 0;
      border-radius: 0;
      background: var(--surface);
      color: var(--text);
    }
    .thread-row[data-selected="true"] {
      background: var(--color-surface-active);
      box-shadow: inset 3px 0 0 var(--accent);
    }
    .row-link {
      min-height: 0;
      width: 100%;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: inherit;
      padding: 4px 0;
      text-align: left;
      font-weight: 600;
    }
    .row-link:hover {
      color: var(--accent);
      border-color: transparent;
      background: transparent;
      text-decoration: underline;
    }
    .empty-row {
      color: var(--muted);
    }
    .row {
      min-height: 52px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 9px 10px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      background: var(--surface);
    }
    .row.compact {
      min-height: 44px;
    }
    .row-actions {
      display: flex;
      gap: 7px;
      align-items: center;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .pill {
      min-height: 24px;
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 0 8px;
      color: var(--muted);
      background: var(--color-surface-hover);
      font-size: 12px;
      white-space: nowrap;
    }
    .pill[data-kind="ok"] {
      color: var(--ok);
      border-color: var(--tone-ok-border);
      background: var(--tone-ok-bg);
    }
    .pill[data-kind="warn"] {
      color: var(--warn);
      border-color: var(--tone-warn-border);
      background: var(--tone-warn-bg);
    }
    .notice {
      border: 1px solid var(--tone-warn-border);
      border-radius: 8px;
      background: var(--tone-warn-bg);
      color: var(--warn);
      padding: 10px 12px;
      font-size: 13px;
    }
    .runtime-summary {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      padding: 8px 10px;
    }
    .runtime-card {
      display: grid;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      padding: 10px 12px;
      max-width: 880px;
      min-width: 0;
    }
    .runtime-card[data-kind="approval"], .runtime-card[data-kind="question"] {
      border-color: var(--tone-warn-border);
      background: var(--tone-warn-bg);
    }
    .runtime-card-header {
      display: flex;
      gap: 8px;
      align-items: center;
      min-width: 0;
    }
    .runtime-card-header strong {
      overflow-wrap: anywhere;
    }
    .question-block {
      display: grid;
      gap: 6px;
    }
    .question-block p {
      margin: 0;
      line-height: 1.45;
    }
    .choice-row {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
    }
    .runtime-detail {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      padding: 8px 10px;
      max-width: 880px;
      min-width: 0;
    }
    .runtime-detail summary {
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 28px;
    }
    .runtime-detail pre {
      overflow: auto;
      margin: 8px 0 0;
      padding: 8px;
      border-radius: 6px;
      background: var(--muted-surface);
      color: var(--text);
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .runtime-error {
      display: flex;
      align-items: center;
      gap: 8px;
      max-width: 880px;
    }
    .empty {
      margin: 0;
      color: var(--muted);
      line-height: 1.45;
    }
    .chat-shell {
      display: grid;
      grid-template-rows: auto minmax(260px, 1fr);
      min-height: 520px;
    }
    .timeline {
      display: grid;
      gap: 10px;
      align-content: start;
      overflow: auto;
      max-height: 58vh;
      padding-right: 2px;
    }
    .message-bubble {
      max-width: 880px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      background: var(--surface);
    }
    .message-bubble[data-role="assistant"] {
      background: var(--color-surface-hover);
    }
    .message-heading {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      margin-bottom: 6px;
    }
    .message-bubble p {
      margin: 0;
      white-space: pre-wrap;
      line-height: 1.5;
    }
    .wait-banner, .activity-row {
      display: flex;
      gap: 8px;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      padding: 8px 10px;
      min-width: 0;
    }
    .activity-block {
      display: grid;
      gap: 8px;
      border-top: 1px solid var(--line);
      padding-top: 10px;
    }
    .activity-block h4 {
      margin: 0;
      font-size: 13px;
    }
    .secret-reveal {
      border: 1px solid var(--tone-ok-border);
      border-radius: 8px;
      background: var(--tone-ok-bg);
      padding: 10px;
      display: grid;
      gap: 6px;
    }
    .secret-reveal input {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    [data-provider-field][hidden] {
      display: none;
    }
    body:not([data-auth="signed-in"]) .signed-in-only {
      display: none;
    }
    body[data-auth="signed-in"] .signed-out-only {
      display: none;
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        scroll-behavior: auto !important;
        transition-duration: 0.01ms !important;
      }
    }
    @media (max-width: 920px) {
      .shell {
        grid-template-columns: 1fr;
      }
      .nav {
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .grid, .form-grid, .workbench-split {
        grid-template-columns: 1fr;
      }
      .table-shell {
        overflow-x: auto;
      }
      .table-row {
        min-width: 620px;
      }
      .topbar {
        align-items: flex-start;
        flex-direction: column;
      }
      .topbar-actions {
        justify-content: flex-start;
      }
      .row {
        grid-template-columns: 1fr;
      }
      .row-actions {
        justify-content: flex-start;
      }
    }
`
}

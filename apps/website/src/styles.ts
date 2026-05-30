import type { PublicBrandingConfig } from '@open-cowork/shared'
import { publicBrandingCss } from './branding.ts'

export function cloudWebsiteStyles(branding: PublicBrandingConfig) {
  return String.raw`    :root {
      color-scheme: light;
${publicBrandingCss(branding)}
      --shadow: 0 8px 24px rgba(24, 33, 28, 0.08);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
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
      color: #fff;
    }
    button.primary:hover {
      background: var(--accent-strong);
      border-color: var(--accent-strong);
    }
    button.danger {
      color: var(--danger);
      border-color: #d9bbb8;
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
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--text);
      padding: 0 10px;
      min-width: 0;
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
      background: var(--text);
      color: #fff;
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
      background: var(--surface);
      border: 1px solid var(--line);
      box-shadow: 0 1px 0 rgba(24, 33, 28, 0.04);
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
      background: #fff;
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
      background: #fff;
      color: var(--text);
    }
    .thread-row[data-selected="true"] {
      background: #eef8f2;
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
      background: #fff;
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
      background: #f7f8f6;
      font-size: 12px;
      white-space: nowrap;
    }
    .pill[data-kind="ok"] {
      color: var(--ok);
      border-color: #a6cfb8;
      background: #eef8f2;
    }
    .pill[data-kind="warn"] {
      color: var(--warn);
      border-color: #dfc48f;
      background: #fff8e8;
    }
    .notice {
      border: 1px solid #dfc48f;
      border-radius: 8px;
      background: #fff8e8;
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
      background: #fff;
      padding: 8px 10px;
    }
    .runtime-card {
      display: grid;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      padding: 10px 12px;
      max-width: 880px;
      min-width: 0;
    }
    .runtime-card[data-kind="approval"], .runtime-card[data-kind="question"] {
      border-color: #dfc48f;
      background: #fffdf6;
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
      background: #fff;
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
      background: #fff;
    }
    .message-bubble[data-role="assistant"] {
      background: var(--muted-surface);
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
      background: #fff;
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
      border: 1px solid #a6cfb8;
      border-radius: 8px;
      background: #eef8f2;
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
